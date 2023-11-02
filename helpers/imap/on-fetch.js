/*
 * Copyright (c) Forward Email LLC
 * SPDX-License-Identifier: MPL-2.0
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * This file incorporates work covered by the following copyright and
 * permission notice:
 *
 *   WildDuck Mail Agent is licensed under the European Union Public License 1.2 or later.
 *   https://github.com/nodemailer/wildduck
 */

const _ = require('lodash');
const getStream = require('get-stream');
const mongoose = require('mongoose');
const safeStringify = require('fast-safe-stringify');
const tools = require('wildduck/lib/tools');
const { Builder } = require('json-sql');
const { imapHandler } = require('wildduck/imap-core');

const IMAPError = require('#helpers/imap-error');
const Mailboxes = require('#models/mailboxes');
const Messages = require('#models/messages');
const ServerShutdownError = require('#helpers/server-shutdown-error');
const SocketError = require('#helpers/socket-error');
const i18n = require('#helpers/i18n');
const refineAndLogError = require('#helpers/refine-and-log-error');
const { convertResult } = require('#helpers/mongoose-to-sqlite');

// const LIMITED_PROJECTION_KEYS = new Set(['_id', 'flags', 'modseq', 'uid']);
const MAX_PAGE_SIZE = 2500;
const MAX_BULK_WRITE_SIZE = 150;

const builder = new Builder();

// eslint-disable-next-line complexity, max-params
async function getMessages(db, wsp, session, server, opts = {}) {
  const { options, projection, query, mailbox, alias, attachmentStorage } =
    opts;

  server.logger.debug('getting messages', opts);

  // safeguard
  if (!_.isObject(query) || _.isEmpty(query))
    throw new Error('Query cannot be empty');

  // safeguard for mailbox
  if (!query?.mailbox || !mongoose.Types.ObjectId.isValid(query.mailbox))
    throw new Error('Mailbox missing from query');

  if (!_.isObject(attachmentStorage))
    throw new Error('Attachment storage missing');

  let { entries, bulkWrite, successful, lastUid, rowCount, totalBytes } = opts;

  //
  // extra safeguards for development
  //
  if (!Array.isArray(entries)) throw new Error('Entries is not an array');

  if (!Array.isArray(bulkWrite)) throw new Error('Bulk write is not an array');

  if (typeof successful !== 'boolean')
    throw new Error('Successful is not a boolean');

  if (typeof lastUid !== 'number' && lastUid !== null)
    throw new Error('Last uid must be a number or null');

  if (typeof rowCount !== 'number' || rowCount < 0)
    throw new Error('Row count must be a number >= 0');

  if (typeof totalBytes !== 'number' || totalBytes < 0)
    throw new Error('Total bytes must be a number >= 0');

  let queryAll;
  let count = 0;

  const pageQuery = { ...query };

  // `1:*`
  if (options.messages.length === session.selected.uidList.length)
    queryAll = true;
  // NOTE: don't use uid for `1:*`
  else pageQuery.uid = tools.checkRangeQuery(options.messages, false);

  if (lastUid) {
    if (pageQuery.uid)
      pageQuery.$and = [
        {
          uid: pageQuery.uid
        },
        { uid: { $gt: lastUid } }
      ];
    else pageQuery.uid = { $gt: lastUid };
  }

  // converts objectids -> strings and arrays/json appropriately
  const condition = JSON.parse(safeStringify(pageQuery));

  // TODO: `condition` may need further refined for accuracy (e.g. see `prepareQuery`)

  const fields = [];
  for (const key of Object.keys(projection)) {
    if (projection[key] === true) fields.push(key);
  }

  const sql = builder.build({
    type: 'select',
    table: 'Messages',
    condition,
    fields,
    // sort required for IMAP UIDPLUS
    sort: 'uid'
    // no limits right now:
    // limit: MAX_PAGE_SIZE
  });

  //
  // NOTE: use larger batch size if the query was limited in its projection
  //
  // max batch size in mongoose is 5000
  // <https://github.com/Automattic/mongoose/blob/1f6449576aac47dcb43f9974bb187a4f13d413d3/lib/cursor/QueryCursor.js#L78C1-L83>
  //
  // the default in mongodb for find query is 101
  // <https://www.mongodb.com/docs/manual/tutorial/iterate-a-cursor/#cursor-batches>
  //
  // const batchSize: !Object.keys(projection).some(
  //   (key) => !LIMITED_PROJECTION_KEYS.has(key)
  // )
  //   ? 1000
  //   : 101

  //
  // TODO: we may want to use `.all()` instead of `.all()`
  // with the `batchSize` value at a time (for better performance)
  //
  let messages;

  if (db.wsp) {
    messages = await wsp.request({
      action: 'stmt',
      session: { user: session.user },
      stmt: [
        ['prepare', sql.query],
        ['all', sql.values]
      ]
    });
  } else {
    // <https://github.com/m4heshd/better-sqlite3-multiple-ciphers/blob/master/docs/api.md#iteratebindparameters---iterator>
    // messages = db.prepare(sql.query).iterate(sql.values);
    messages = db.prepare(sql.query).all(sql.values);
  }

  for (const result of messages) {
    // eslint-disable-next-line no-await-in-loop
    const message = await convertResult(Messages, result, projection);

    server.logger.debug('fetched message', {
      result,
      message,
      session,
      options,
      query,
      pageQuery
    });

    // check if server is in the process of shutting down
    if (server._closeTimeout) throw new ServerShutdownError();

    // check if socket is still connected
    const socket = (session.socket && session.socket._parent) || session.socket;
    if (!socket || socket?.destroyed || socket?.readyState !== 'open')
      throw new SocketError();

    // break out of cursor if no message retrieved
    // TODO: does this actually occur as an edge case (?)
    if (!message) {
      server.logger.fatal('message not fetched', {
        session,
        options,
        query,
        pageQuery
      });

      // may have more pages, try to fetch more
      if (count === MAX_PAGE_SIZE) {
        // eslint-disable-next-line no-await-in-loop
        const results = await getMessages(db, wsp, session, server, {
          options,
          projection,
          query,
          mailbox,
          alias,
          attachmentStorage,
          entries,
          bulkWrite,
          successful,
          lastUid,
          rowCount,
          totalBytes
        });
        // re-assign variables (or we could return early here with `results`)
        entries = results.entries;
        bulkWrite = results.bulkWrite;
        successful = results.successful;
        lastUid = results.lastUid;
        rowCount = results.rowCount;
        totalBytes = results.totalBytes;
      }

      break;
    }

    // store counter for how many messages we processed
    count++;

    // store reference to last message uid
    lastUid = message.uid;

    // don't process messages that are new since query started
    if (
      queryAll &&
      typeof session?.selected?.uidList === 'object' &&
      Array.isArray(session.selected.uidList) &&
      !session.selected.uidList.includes(message.uid)
    )
      continue;

    const markAsSeen =
      options.markAsSeen && message.flags && !message.flags.includes('\\Seen');
    if (markAsSeen) message.flags.unshift('\\Seen');

    // write the response early since we don't need to perform db operation
    if (options.metadataOnly && !markAsSeen) {
      // eslint-disable-next-line no-await-in-loop
      const values = await Promise.all(
        session
          .getQueryResponse(options.query, message, {
            logger: server.logger,
            fetchOptions: {},
            // database
            attachmentStorage,
            acceptUTF8Enabled: session.isUTF8Enabled()
          })
          .map((obj) => {
            if (
              typeof obj !== 'object' ||
              obj.type !== 'stream' ||
              typeof obj.value !== 'object'
            )
              return obj;
            return getStream(obj.value);
          })
      );
      const data = session.formatResponse('FETCH', message.uid, {
        query: options.query,
        values
      });
      const compiled = imapHandler.compiler(data);
      // `compiled` is a 'binary' string
      totalBytes += compiled.length;
      session.writeStream.write({ compiled });
      rowCount++;

      //
      // NOTE: we may need to pass indexer options here as similar to wildduck (through the use of `eachAsync`)
      // <https://mongoosejs.com/docs/api/querycursor.html#QueryCursor.prototype.eachAsync()>
      // (e.g. so we can do `await Promise.resolve((resolve) => setImmediate(resolve));`)
      //

      // move along to next cursor
      continue;
    }

    //
    // NOTE: wildduck uses streams and a TTL limiter/counter however we can
    // simplify this for now just by writing to the socket writable stream
    //
    // eslint-disable-next-line no-await-in-loop
    const values = await Promise.all(
      session
        .getQueryResponse(options.query, message, {
          logger: server.logger,
          fetchOptions: {},
          // database
          attachmentStorage,
          acceptUTF8Enabled: session.isUTF8Enabled()
        })
        .map((obj) => {
          if (
            typeof obj !== 'object' ||
            obj.type !== 'stream' ||
            typeof obj.value !== 'object'
          )
            return obj;
          return getStream(obj.value);
        })
    );

    const data = session.formatResponse('FETCH', message.uid, {
      query: options.query,
      values
    });
    const compiled = imapHandler.compiler(data);
    // `compiled` is a 'binary' string
    totalBytes += compiled.length;
    session.writeStream.write({ compiled });
    rowCount++;

    // add operation to bulkWrite
    if (!markAsSeen)
      bulkWrite.push({
        updateOne: {
          filter: {
            _id: message._id,
            mailbox: mailbox._id,
            uid: message.uid
          },
          update: {
            $addToSet: {
              flags: '\\Seen'
            },
            $set: {
              unseen: false
            }
          }
        }
      });

    if (bulkWrite.length >= MAX_BULK_WRITE_SIZE) {
      try {
        // eslint-disable-next-line no-await-in-loop
        await Messages.bulkWrite(db, wsp, session, bulkWrite, {
          ordered: false,
          w: 1
        });
        bulkWrite = [];
        if (entries.length >= MAX_BULK_WRITE_SIZE) {
          try {
            // eslint-disable-next-line no-await-in-loop
            await server.notifier.addEntries(
              db,
              wsp,
              session,
              mailbox,
              entries
            );
            entries = [];
            server.notifier.fire(alias.id);
          } catch (err) {
            server.logger.fatal(err, { message, session, options, query });
          }
        }
      } catch (err) {
        bulkWrite = [];
        entries = [];
        server.logger.fatal(err, { message, session, options, query });

        successful = false;
        break;
      }
    }
  }

  return {
    entries,
    bulkWrite,
    successful,
    lastUid,
    rowCount,
    totalBytes
  };
}

async function onFetch(mailboxId, options, session, fn) {
  this.logger.debug('FETCH', { mailboxId, options, session });

  try {
    const { alias, db } = await this.refreshSession(session, 'FETCH');

    const mailbox = await Mailboxes.findOne(db, this.wsp, session, {
      _id: mailboxId
    });

    if (!mailbox)
      throw new IMAPError(i18n.translate('IMAP_MAILBOX_DOES_NOT_EXIST', 'en'), {
        imapResponse: 'NONEXISTENT'
      });

    const projection = {
      _id: true,
      uid: true,
      modseq: true
    };

    if (options.flagsExist) projection.flags = true;
    if (options.idateExist) projection.idate = true;
    if (options.bodystructureExist) projection.bodystructure = true;
    if (options.rfc822sizeExist) projection.size = true;
    if (options.envelopeExist) projection.envelope = true;
    if (!options.metadataOnly) projection.mimeTree = true;

    const query = {
      mailbox: mailbox._id
    };

    if (options.changedSince)
      query.modseq = {
        $gt: options.changedSince
      };

    const results = await getMessages(db, this.wsp, session, this.server, {
      options,
      projection,
      query,
      mailbox,
      alias,
      attachmentStorage: this.attachmentStorage,
      entries: [],
      bulkWrite: [],
      successful: true,
      lastUid: null,
      rowCount: 0,
      totalBytes: 0
    });

    // mark messages as Seen
    if (results.bulkWrite.length > 0)
      await Messages.bulkWrite(db, this.wsp, session, results.bulkWrite, {
        ordered: false,
        w: 1
      });

    // close the connection
    db.close();

    if (results.entries.length > 0) {
      try {
        await this.server.notifier.addEntries(
          db,
          this.wsp,
          session,
          mailbox,
          results.entries
        );
        this.server.notifier.fire(alias.id);
      } catch (err) {
        this.logger.fatal(err, { mailboxId, options, session });
      }
    }

    fn(null, results.successful, {
      rowCount: results.rowCount,
      totalBytes: results.totalBytes
    });
  } catch (err) {
    // NOTE: wildduck uses `imapResponse` so we are keeping it consistent
    if (err.imapResponse) {
      this.logger.error(err, { mailboxId, options, session });
      return fn(null, err.imapResponse);
    }

    fn(refineAndLogError(err, session, true));
  }
}

module.exports = onFetch;
