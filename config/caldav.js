/**
 * Copyright (c) Forward Email LLC
 * SPDX-License-Identifier: BUSL-1.1
 */

const { randomUUID } = require('node:crypto');

const Boom = require('@hapi/boom');
const Lock = require('ioredfour');
const _ = require('lodash');
const caldavAdapter = require('caldav-adapter');
const dayjs = require('dayjs-with-plugins');
const etag = require('etag');
const ipaddr = require('ipaddr.js');
const isFQDN = require('is-fqdn');
const mongoose = require('mongoose');
const sharedConfig = require('@ladjs/shared-config');
const splitLines = require('split-lines');
const { default: ical } = require('ical-generator');
const { rrulestr, Frequency } = require('rrule');

const env = require('./env');

const config = require('.');

const Calendars = require('#models/calendars');
const CalendarEvents = require('#models/calendar-events');
const createTangerine = require('#helpers/create-tangerine');
const createWebSocketAsPromised = require('#helpers/create-websocket-as-promised');
const i18n = require('#helpers/i18n');
const logger = require('#helpers/logger');
const onAuth = require('#helpers/on-auth');
const parseRootDomain = require('#helpers/parse-root-domain');
const refreshSession = require('#helpers/refresh-session');

const sharedCalDAVConfig = sharedConfig('CALDAV');

const RRULES = ['DTSTART', 'RRULE', 'EXRULE', 'EXDATE', 'RDATE'];

const RATELIMIT_ALLOWLIST =
  typeof env.RATELIMIT_ALLOWLIST === 'string'
    ? env.RATELIMIT_ALLOWLIST.split(',')
    : Array.isArray(env.RATELIMIT_ALLOWLIST)
    ? env.RATELIMIT_ALLOWLIST
    : [];

async function onAuthPromise(auth, session) {
  return new Promise((resolve, reject) => {
    onAuth.call(this, auth, session, (err, user) => {
      if (err) return reject(err);
      resolve(user);
    });
  });
}

// TODO: note there is a bug with node-ical with recurring event timezone parsing
// <https://github.com/jens-maus/node-ical/pull/231>

// eslint-disable-next-line complexity
function transformEventForICal(event) {
  let repeating = null;
  let hasRepeating = false;
  let priority;

  const lines = [];
  // TODO: RRULE parsing needs to occur between VEVENT blocks
  for (const line of splitLines(event.ical)) {
    if (line.startsWith('RRULE:')) hasRepeating = true;
    if (RRULES.some((rrule) => line.startsWith(`${rrule}:`))) lines.push(line);
    if (line.startsWith('PRIORITY:') && /\d+/.test(line))
      priority = Number.parseInt(line.match(/\d+/)[0], 10);
  }

  if (lines.length > 0 && hasRepeating) {
    const rruleSet = rrulestr(lines.join('\n'));
    // <https://github.com/jkbrzt/rrule/blob/9f2061febeeb363d03352efe33d30c33073a0242/src/rrule.ts#L37-L57>
    if (
      typeof rruleSet === 'object' &&
      typeof rruleSet.options === 'object' &&
      !_.isEmpty(rruleSet.options)
    ) {
      const { options } = rruleSet;
      repeating = {
        freq: Frequency[options.freq],
        count: options.count || undefined,
        interval: options.interval || undefined,
        until: options.until || undefined,
        // <https://github.com/jkbrzt/rrule/blob/9f2061febeeb363d03352efe33d30c33073a0242/src/optionstostring.ts#L44>
        byDay: options.byweekday || undefined,
        byMonth: options.bymonth || undefined,
        byMonthDay: options.bymonthday || undefined,
        bySetPos: options.bysetpos || undefined,
        exclude:
          typeof rruleSet.exdates === 'function'
            ? rruleSet.exdates()
            : undefined,
        startOfWeek: options.wkst || undefined
      };
    }
  }

  let timezone;
  if (event.ical && event.ical.includes('TZID='))
    timezone = event.ical.split('TZID=')[1].split(':')[0].trim();

  let allDay = Boolean(
    _.isDate(event.start) &&
      _.isDate(event.end) &&
      dayjs(event.start).startOf('day').toDate().getTime() ===
        event.start.getTime() &&
      dayjs(event.start).endOf('day')
  );

  //
  // this adds arbitrary boolean support detection for all day flag
  //
  // X-FUNAMBOL-ALLDAY:1
  // X-MICROSOFT-CDO-ALLDAYEVENT:TRUE
  // X-MICROSOFT-MSNCALENDAR-ALLDAYEVENT:TRUE
  //
  if (
    event.ical &&
    (event.ical.includes('X-FUNAMBOL-ALLDAY:1') ||
      event.ical.includes('X-MICROSOFT-CDO-ALLDAYEVENT:TRUE') ||
      event.ical.includes('X-MICROSOFT-MSNCALENDAR-ALLDAYEVENT:TRUE'))
  )
    allDay = true;

  return {
    id: event.uid,
    sequence: event.sequence || undefined,
    start: event.start || undefined,
    end: event.end || undefined,
    recurrenceId: event.recurrenceid || undefined,
    timezone,
    stamp: event.dtstamp || undefined,

    // `allDay` (Boolean)
    allDay,

    // `floating` (Boolean)
    // floating events are considered floating if the event doesn't have a timezone (?)
    // usually this is only set for `UNTIL` and appends timezone "Z"
    floating: timezone ? event.datetype !== 'date-time' : false,

    // <https://github.com/sebbo2002/ical-generator/blob/dcf28ab313c3d53db4d50da021873d699b5b3030/src/event.ts#L146-L157>
    repeating,

    summary: event.summary || undefined,
    location: event.location || undefined,
    description: event.description || undefined,
    organizer: event.organizer || undefined,
    attendees: event.attendee
      ? Array.isArray(event.attendee)
        ? event.attendee
        : [event.attendee]
      : undefined,

    // TODO: not yet supported by node-ical
    //       <https://github.com/jens-maus/node-ical/pull/299>
    alarms: undefined,

    categories: event.categories || undefined,
    status: event.status || undefined,
    busystatus: event.freebusy || undefined,

    // NOTE: not yet supportedi by node-ical
    priority,

    url: event.url || undefined,

    // TODO: not yet supported node-ical
    attachments: undefined,

    transparency: event.transparency || undefined,
    created: event.created || null,
    lastModified: event.lastmodified || null,
    x: event.x || undefined
  };
}

function bumpSyncToken(synctoken) {
  const parts = synctoken.split('/');
  return (
    parts.slice(0, -1).join('/') +
    '/' +
    (Number.parseInt(parts[parts.length - 1], 10) + 1)
  );
}

// function formatDate(date) {
//   return moment(date).utc().format('YYYYMMDDTHHmmss[Z]');
// }

// TODO: add scheduling support
// <https://github.com/sedenardi/node-caldav-adapter/blob/3acc55fcb615adc8cc394b7c63dbc702a498d591/README.md?plain=1#L253-L255>

// TODO: submit PR to include Forward Email in this list
// <https://github.com/natelindev/tsdav/blob/c884cbc006f049c16f5c5c5bc964f1c7c83a9c01/docs/docs/intro.md?plain=1#L11>
// <https://github.com/natelindev/tsdav/blob/c884cbc006f049c16f5c5c5bc964f1c7c83a9c01/docs/docs/cloud%20providers.md#fastmail>

// TODO: move this to `caldav-server.js` similar to `imap-server.js` (?)
// <https://github.com/sedenardi/node-caldav-adapter/issues/14>

//
// CalDAV
// <https://www.rfc-editor.org/rfc/rfc4791>
//
class CalDAV {
  constructor(ctx, wspPort) {
    this.ctx = ctx;
    this.authenticate = this.authenticate.bind(this);
    this.createCalendar = this.createCalendar.bind(this);
    this.getCalendar = this.getCalendar.bind(this);
    // this.updateCalendar = this.updateCalendar.bind(this);
    this.getCalendarsForPrincipal = this.getCalendarsForPrincipal.bind(this);
    this.getEventsForCalendar = this.getEventsForCalendar.bind(this);
    this.getEventsByDate = this.getEventsByDate.bind(this);
    this.getEvent = this.getEvent.bind(this);
    this.createEvent = this.createEvent.bind(this);
    this.updateEvent = this.updateEvent.bind(this);
    this.deleteEvent = this.deleteEvent.bind(this);
    this.buildICS = this.buildICS.bind(this);
    this.getCalendarId = this.getCalendarId.bind(this);
    this.getETag = this.getETag.bind(this);

    // TODO: this.client
    // TODO: this.subscriber

    // TODO: wsp.close()
    this.wsp = createWebSocketAsPromised({
      port: wspPort
    });

    // lock for read/writes
    this.lock = new Lock({
      redis: ctx.client,
      namespace: config.imapLockNamespace
    });

    this.logger = logger;
    this.server = ctx.app;
    this.resolver = this.ctx.resolver;
    this.client = this.ctx.client;
  }

  async authenticate({ username, password, principalId }) {
    // obj.username
    // obj.password
    // obj.principalId
    logger.debug('authenticate', { username, password, principalId });

    const { ctx } = this;
    ctx.state.session = {
      id: ctx.req.id,
      remoteAddress: ctx.ip,
      request: ctx.request
    };

    try {
      const { user } = await onAuthPromise.call(
        this,
        // auth
        {
          username,
          password
        },
        // session
        ctx.state.session
      );

      // caldav related user properties
      user.principalId = user.username;
      user.principalName = user.username; // .toUpperCase()

      // set user in session and state
      ctx.state.user = user;
      ctx.state.session.user = user;

      // set locale for translation in ctx
      ctx.isAuthenticated = () => true;
      ctx.request.acceptsLanguages = () => false;
      await i18n.middleware(ctx, () => Promise.resolve());

      // connect to db
      await refreshSession.call(this, ctx.state.session, 'CALDAV');

      // ensure that the default calendar exists
      const defaultCalendar = await this.getCalendar({
        calendarId: user.username,
        principalId: user.username,
        user
      });

      logger.debug('defaultCalendar', { defaultCalendar });

      return user;
    } catch (err) {
      logger.error(err);
      throw Boom.unauthorized(err);
    }
  }

  async createCalendar({ name, description, timezone }) {
    logger.debug('createCalendar', {
      name,
      description,
      timezone,
      params: this.ctx.state.params
    });
    name = name || this.ctx.state.params.calendarId || randomUUID();
    const calendarId = this.ctx.state.params.calendarId || name;
    return Calendars.create({
      // db virtual helper
      instance: this,
      session: this.ctx.state.session,

      // calendarId
      calendarId,

      // calendar obj
      name,
      description: description || config.urls.web,
      prodId: `//forwardemail.net//caldav//${this.ctx.locale.toUpperCase()}`,
      timezone: timezone || this.ctx.state.session.user.timezone,
      url: config.urls.web,
      readonly: false,
      synctoken: `${config.urls.web}/ns/sync-token/1`
    });
  }

  // https://caldav.forwardemail.net/dav/support@forwardemail.net/default
  async getCalendar({ calendarId, principalId, user }) {
    logger.debug('getCalendar', { calendarId, principalId, user });

    let calendar;
    if (mongoose.isObjectIdOrHexString(calendarId))
      calendar = await Calendars.findOne(this, this.ctx.state.session, {
        _id: new mongoose.Types.ObjectId(calendarId)
      });
    if (!calendar)
      calendar = await Calendars.findOne(this, this.ctx.state.session, {
        calendarId
      });
    if (!calendar)
      calendar = await Calendars.create({
        // db virtual helper
        instance: this,
        session: this.ctx.state.session,

        // calendarId
        calendarId,

        // calendar obj
        // NOTE: Android uses "Events" and most others use "Calendar" as default calendar name
        name: this.ctx.translate('CALENDAR'),
        description: config.urls.web,
        prodId: `//forwardemail.net//caldav//${this.ctx.locale.toUpperCase()}`,
        //
        // NOTE: instead of using timezone from IP we use
        //       their last time zone set in a browser session
        //       (this is way more accurate and faster)
        //
        //       here were some alternatives though during R&D:
        //       * <https://github.com/runk/node-maxmind>
        //       * <https://github.com/evansiroky/node-geo-tz>
        //       * <https://github.com/safing/mmdbmeld>
        //       * <https://github.com/sapics/ip-location-db>
        //
        timezone: this.ctx.state.session.user.timezone,
        url: config.urls.web,
        readonly: false,
        synctoken: `${config.urls.web}/ns/sync-token/1`
      });

    logger.debug('getCalendar result', { calendar });

    return calendar;
  }

  //
  // TODO: updateCalendar support
  // <https://github.com/sedenardi/node-caldav-adapter/blob/bdfbe17931bf14a1803da77dbb70509db9332695/example/server.js#L33>
  // <https://github.com/sedenardi/node-caldav-adapter/blob/bdfbe17931bf14a1803da77dbb70509db9332695/example/data.js#L111-L120>
  //

  // https://caldav.forwardemail.net/dav/support@forwardemail.net <--- both of these would do the same
  // https://caldav.forwardemail.net/dav/calendars <--- both of these would do the same
  // NOTE: in the future we could do readonly and sharing here with auth permissioning system
  async getCalendarsForPrincipal({ principalId, user }) {
    logger.debug('getCalendarsForPrincipal', { principalId, user });
    return Calendars.find(this, this.ctx.state.session, {});
  }

  async getEventsForCalendar({ calendarId, principalId, user, fullData }) {
    logger.debug('getEventsForCalendar', {
      calendarId,
      principalId,
      user,
      fullData
    });

    const calendar = await this.getCalendar({ calendarId, principalId, user });

    return CalendarEvents.find(this, this.ctx.state.session, {
      calendar: calendar._id
    });
  }

  async getEventsByDate({
    calendarId,
    start,
    end,
    principalId,
    user,
    fullData
  }) {
    logger.debug('getEventsByDate', {
      calendarId,
      start,
      end,
      principalId,
      user,
      fullData
    });

    const calendar = await this.getCalendar({ calendarId, principalId, user });

    // TODO: incorporate database date query instead of this in-memory filtering
    // TODO: we could do partial query for not recurring and b/w and then has recurring and after
    const events = await CalendarEvents.find(this, this.ctx.state.session, {
      calendar: calendar._id
    });

    const filtered = [];

    //
    // NOTE: an event can have multiple RRULE, RDATE, EXDATE values
    //
    for (const event of events) {
      const lines = [];
      // TODO: RRULE parsing needs to occur between VEVENT blocks
      for (const line of splitLines(event.ical)) {
        if (RRULES.some((rrule) => line.startsWith(`${rrule}:`)))
          lines.push(line);
      }

      // TODO: we may only want to do this if it has `RRULE`
      if (lines.length === 0) {
        if ((!start || start <= event.end) && (!end || end >= event.start))
          filtered.push(event);
        continue;
      }

      const rruleSet = rrulestr(lines.join('\n'));

      // check queried date range (if both start and end specified)
      if (start && end) {
        const dates = rruleSet.between(start, end, true);
        if (dates.length > 0) {
          filtered.push(event);
        }

        continue;
      }

      // if only start specified
      if (start) {
        const date = rruleSet.after(start, true);
        if (date) {
          filtered.push(event);
        }

        continue;
      }

      // if only end specified
      if (end) {
        const date = rruleSet.before(end, true);
        if (date) {
          filtered.push(event);
        }

        continue;
      }
    }

    return filtered;
  }

  async getEvent({ eventId, principalId, calendarId, user, fullData }) {
    logger.debug('getEvent', {
      eventId,
      principalId,
      calendarId,
      user,
      fullData
    });

    const calendar = await this.getCalendar({ calendarId, principalId, user });

    const event = await CalendarEvents.findOne(this, this.ctx.state.session, {
      eventId,
      calendar: calendar._id
    });

    return event;
  }

  // eventId: ctx.state.params.eventId,
  // principalId: ctx.state.params.principalId,
  // calendarId: ctx.state.params.calendarId,
  // event: incoming,
  // user: ctx.state.user
  // NOTE: `ical` String is also ctx.request.body in this method
  async createEvent({ eventId, principalId, calendarId, event, user }) {
    logger.debug('createEvent', {
      eventId,
      principalId,
      calendarId,
      event,
      user
    });

    const calendar = await this.getCalendar({ calendarId, principalId, user });

    // check if there is an event with same calendar ID already
    const exists = await CalendarEvents.findOne(this, this.ctx.state.session, {
      eventId,
      calendar: calendar._id
    });

    if (exists)
      throw Boom.badRequest(this.ctx.translateError('EVENT_ALREADY_EXISTS'));

    await Calendars.findByIdAndUpdate(
      this,
      this.ctx.state.session,
      calendar._id,
      {
        $set: {
          synctoken: bumpSyncToken(calendar.synctoken)
        }
      }
    );

    const calendarEvent = {
      // db virtual helper
      instance: this,
      session: this.ctx.state.session,

      // event obj
      eventId,
      dtstamp: event.dtstamp,
      uid: event.uid,
      calendar: calendar._id,
      sequence: event.sequence,
      transparency: event.transparency,
      class: event.class,
      summary: event.summary,
      start: event.start,
      datetype: event.datetype,
      end: event.end,
      location: event.location,
      description: event.description,
      url: event.url,
      completion: event.completion,
      method: event.method,
      created: event.created,
      lastmodified: event.lastmodified,
      attendee: event.attendee,
      recurrences: event.recurrences,
      status: event.status,
      organizer: event.organizer,
      geo: event.geo,
      recurrenceid: event.recurrenceid,
      ical: this.ctx.request.ical ? this.ctx.request.body : null,
      completed: event.completed,
      freebusy: event.freebusy,
      categories: event.categories
    };

    //
    // TODO: if user logs into CalDAV and does not have SMTP enabled and verified
    //       then send the user an email and notify them that calendar invites
    //       will not get automatically emailed until they set this up properly
    //       at https://forwardemail.net/my-account/domains/yourdomain.com/verify-smtp
    //

    // NOTE: here is Thunderbird's implementation of itip
    //       <https://github.com/mozilla/releases-comm-central/blob/0b146e856d83fc7189a6e79800871916fc00e725/calendar/base/modules/utils/calItipUtils.sys.mjs#L31>

    // TODO: ensure we have support for all these RFC's down the road
    //       <https://stackoverflow.com/a/36344164>
    //       <https://github.com/nextcloud/calendar/wiki/Developer-Resources#rfcs>

    //
    // TODO: actually send invites via email and attach ics file
    //       <https://datatracker.ietf.org/doc/html/rfc6047#section-2.5>
    //       <https://sabre.io/dav/scheduling/>
    //       <https://datatracker.ietf.org/doc/html/rfc6047>
    //
    // X-MOZ-SEND-INVITATIONS:TRUE
    // X-MOZ-SEND-INVITATIONS-UNDISCLOSED:FALSE
    //
    // if SCHEDULE-AGENT=CLIENT then do not send invite
    //
    // From: user1@example.com
    // To: user2@example.com
    // Subject: Phone Conference
    // Mime-Version: 1.0
    // Date: Wed, 07 May 2008 21:30:25 +0400
    // Message-ID: <4821E731.5040506@laptop1.example.com>
    // Content-Type: text/calendar; method=REQUEST; charset=UTF-8
    // Content-Transfer-Encoding: quoted-printable
    //
    // BEGIN:VCALENDAR
    // PRODID:-//Example/ExampleCalendarClient//EN
    // METHOD:REQUEST
    // VERSION:2.0
    // BEGIN:VEVENT
    // ORGANIZER:mailto:user1@example.com
    // ATTENDEE;ROLE=CHAIR;PARTSTAT=ACCEPTED:mailto:user1@example.com
    // ATTENDEE;RSVP=YES;CUTYPE=INDIVIDUAL:mailto:user2@example.com
    // DTSTAMP:20080507T170000Z
    // DTSTART:20080701T160000Z
    // DTEND:20080701T163000Z
    // SUMMARY:Phone call to discuss your last visit
    // DESCRIPTION:=D1=82=D1=8B =D0=BA=D0=B0=D0=BA - =D0=B4=D0=BE=D0=
    //  =B2=D0=BE=D0=BB=D0=B5=D0=BD =D0=BF=D0=BE=D0=B5=D0=B7=D0=B4=D0=BA=D0
    //  =BE=D0=B9?
    // UID:calsvr.example.com-8739701987387998
    // SEQUENCE:0
    // STATUS:TENTATIVE
    // END:VEVENT
    // END:VCALENDAR
    //

    //
    // NOTE: see this thread from nextcloud regarding description
    //       and the issues (and cleanup necessary) that was done to support Thunderbird and other clients
    //
    //       <https://github.com/nextcloud/calendar/issues/3863>
    //       <https://github.com/nextcloud/tasks/issues/2239>
    //       <https://github.com/nextcloud/calendar/pull/3924>
    //       <https://github.com/nextcloud/tasks/pull/2240/commits/cb87ab1b5ca3abdfa012e26fbe85827275f4cb66>
    //       <https://github.com/nextcloud/calendar/issues/3234>
    //       <https://github.com/nextcloud/server/pull/41370>
    //

    logger.debug('create calendar event', { calendarEvent });

    return CalendarEvents.create(calendarEvent);
  }

  // NOTE: `ical` String is also ctx.request.body in this method
  async updateEvent({ eventId, principalId, calendarId, event, user }) {
    logger.debug('updateEvent', {
      eventId,
      principalId,
      calendarId,
      event,
      user
    });

    const calendar = await this.getCalendar({ calendarId, principalId, user });

    let e = await CalendarEvents.findOne(this, this.ctx.state.session, {
      eventId,
      calendar: calendar._id
    });

    if (!e)
      throw Boom.badRequest(this.ctx.translateError('EVENT_DOES_NOT_EXIST'));

    await Calendars.findByIdAndUpdate(
      this,
      this.ctx.state.session,
      calendar._id,
      {
        $set: {
          synctoken: bumpSyncToken(calendar.synctoken)
        }
      }
    );

    // db virtual helper
    e.instance = this;
    e.session = this.ctx.state.session;

    // so we can call `save()`
    e.isNew = false;

    // event obj
    e.dtstamp = event.dtstamp;
    e.uid = event.uid;
    e.calendar = calendar._id;
    e.sequence = event.sequence;
    e.transparency = event.transparency;
    e.class = event.class;
    e.summary = event.summary;
    e.start = event.start;
    e.datetype = event.datetype;
    e.end = event.end;
    e.location = event.location;
    e.description = event.description;
    e.url = event.url;
    e.completion = event.completion;
    e.method = event.method;
    e.created = event.created;
    e.lastmodified = event.lastmodified;
    e.attendee = event.attendee;
    e.recurrences = event.recurrences;
    e.status = event.status;
    e.organizer = event.organizer;
    e.geo = event.geo;
    e.recurrenceid = event.recurrenceid;
    e.ical = this.ctx.request.ical ? this.ctx.request.body : null;
    e.completed = event.completed;
    e.freebusy = event.freebusy;
    e.categories = event.categories;

    // save event
    e = await e.save();

    return e;
  }

  async deleteEvent({ eventId, principalId, calendarId, user }) {
    logger.debug('deleteEvent', { eventId, principalId, calendarId, user });

    const calendar = await this.getCalendar({ calendarId, principalId, user });

    const event = await CalendarEvents.findOne(this, this.ctx.state.session, {
      eventId,
      calendar: calendar._id
    });

    if (event) {
      await Calendars.findByIdAndUpdate(
        this,
        this.ctx.state.session,
        calendar._id,
        {
          $set: {
            synctoken: bumpSyncToken(calendar.synctoken)
          }
        }
      );

      await CalendarEvents.deleteOne(this, this.ctx.state.session, {
        _id: event._id
      });
    }

    return event;
  }

  async buildICS(event, calendar) {
    logger.debug('buildICS', { event, calendar });

    // TODO: add support for alarms
    // TODO: preserve DESCRIPTION;ALTREP

    // TODO: remove the conditional below once we update caldav-adapter

    //
    // TODO: until this PR is merged this is a temporary fix
    //       to ensure that VALARM data is returned in calendar response objects
    //       <https://github.com/jens-maus/node-ical/pull/299>
    //
    if (event.ical && event.ical.includes('VALARM')) {
      const err = new Error('VALARM data detected');
      err.event = event;
      err.calendar = calendar;
      logger.error(err, { event, calendar });
      return event.ical;
    }

    // TODO: push and transform according to
    // <https://github.com/sebbo2002/ical-generator/blob/dcf28ab313c3d53db4d50da021873d699b5b3030/src/event.ts#L179-L213>
    // <https://github.com/jens-maus/node-ical/blob/b4008a752136d8e2164519022aedc35ada8e10c3/node-ical.d.ts#L65-L94>
    const events = [];
    events.push(transformEventForICal(event));
    if (Array.isArray(events.recurrences))
      events.push(...events.recurrences.map((r) => transformEventForICal(r)));
    let timezone;
    if (
      event.ical &&
      event.ical.includes('BEGIN:VTIMEZONE') &&
      event.ical.includes('END:VTIMEZONE')
    ) {
      const str = event.ical
        .split('BEGIN:VTIMEZONE')[1]
        .split('END:VTIMEZONE')[0]
        .trim();
      if (str.includes('TZID:')) {
        const lines = splitLines(str);
        for (const line of lines) {
          if (line.startsWith('TZID:')) {
            timezone = line.split('TZID:')[1].split(':')[0].trim();
            break;
          }
        }
      }
    }

    const icalObject = {
      description: calendar.description,
      events,
      // TODO: implement `method`
      // <https://github.com/sebbo2002/ical-generator/blob/dcf28ab313c3d53db4d50da021873d699b5b3030/src/calendar.ts#L63-L72>
      // method: null,
      name: calendar.name,
      prodId: calendar.prodId,
      scale: calendar.scale,
      source: calendar.source,
      timezone,
      ttl: calendar.ttl,
      url: calendar.url,
      //
      // NOTE: we submitted a core bug fix but led us to set a default of `[]`
      //       <https://github.com/sebbo2002/ical-generator/pull/563>
      //
      x: calendar.x || []
    };
    const cal = ical(icalObject);
    return cal.toString(); // this already invokes `foldLines`
  }

  getCalendarId(calendar) {
    return calendar._id.toString();
  }

  getETag(event) {
    return etag(event.updated_at.toISOString());
  }
}

module.exports = {
  ...sharedCalDAVConfig,
  ...config,
  rateLimit: {
    ...sharedCalDAVConfig.rateLimit,
    ...config.rateLimit
  },
  removeTrailingSlashes: false,
  passport: false,
  auth: false,
  routes: false,
  logger,
  i18n,
  hookBeforeRoutes(app, config) {
    // respond with 200 for requests to /
    // (e.g. this is used by status page monitoring)
    app.use((ctx, next) => {
      if (ctx.path === '/' && ['GET', 'HEAD', 'OPTIONS'].includes(ctx.method)) {
        ctx.body = 'OK';
        return;
      }

      return next();
    });

    // this is the magic where we define caldav implementation
    app.use(async (ctx, next) => {
      const caldav = new CalDAV(ctx, config.sqlitePort);
      logger.debug('new request', {
        method: ctx.request.method,
        url: ctx.request.url,
        body: ctx.request.body,
        type: ctx.request.type,
        req: ctx.req
      });
      // TODO: remove this try/catch in the future (useful for debugging)
      try {
        const val = await caldavAdapter({
          authenticate: caldav.authenticate,
          authRealm: 'forwardemail/caldav',
          caldavRoot: '/',
          calendarRoot: 'dav',
          principalRoot: 'principals',
          // <https://github.com/sedenardi/node-caldav-adapter/blob/bdfbe17931bf14a1803da77dbb70509db9332695/src/koa.ts#L130-L131>
          disableWellKnown: false,
          logEnabled: config.env !== 'production',
          logLevel: 'debug',
          data: {
            createCalendar: caldav.createCalendar,
            getCalendar: caldav.getCalendar,
            getCalendarsForPrincipal: caldav.getCalendarsForPrincipal,
            getEventsForCalendar: caldav.getEventsForCalendar,
            getEventsByDate: caldav.getEventsByDate,
            getEvent: caldav.getEvent,
            createEvent: caldav.createEvent,
            updateEvent: caldav.updateEvent,
            deleteEvent: caldav.deleteEvent,
            buildICS: caldav.buildICS,
            getCalendarId: caldav.getCalendarId,
            getETag: caldav.getETag
          }
        })(ctx, next);
        return val;
      } catch (err) {
        logger.error(err);
        throw err;
      }
    });
  },
  hookBeforeSetup(app) {
    app.context.resolver = createTangerine(
      app.context.client,
      app.context.logger
    );
    app.use(async (ctx, next) => {
      // convert local IPv6 addresses to IPv4 format
      // <https://blog.apify.com/ipv4-mapped-ipv6-in-nodejs/>
      if (ipaddr.isValid(ctx.request.ip)) {
        const addr = ipaddr.parse(ctx.request.ip);
        if (addr.kind() === 'ipv6' && addr.isIPv4MappedAddress())
          ctx.request.ip = addr.toIPv4Address().toString();
      }

      // if we need to allowlist certain IP which resolve to our hostnames
      if (ctx.resolver) {
        try {
          // maximum of 3s before ac times out
          const abortController = new AbortController();
          const timeout = setTimeout(() => abortController.abort(), 3000);
          const [clientHostname] = await ctx.resolver.reverse(
            ctx.request.ip,
            abortController
          );
          clearTimeout(timeout);
          if (isFQDN(clientHostname)) {
            if (RATELIMIT_ALLOWLIST.includes(clientHostname))
              ctx.allowlistValue = clientHostname;
            else {
              const rootClientHostname = parseRootDomain(clientHostname);
              if (RATELIMIT_ALLOWLIST.includes(rootClientHostname))
                ctx.allowlistValue = rootClientHostname;
            }
          }
        } catch (err) {
          ctx.logger.warn(err);
        }
      }

      return next();
    });
  }
  // bodyParserIgnoredPathGlobs: ['/v1/log', '/v1/emails']
};
