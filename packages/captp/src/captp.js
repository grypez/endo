/// <reference types="ses"/>

/** @template [R=unknown] @typedef {import('@endo/eventual-send').Settler<R>} Settler */
/** @template [R=unknown] @typedef {import('@endo/eventual-send').HandledExecutor<R>} HandledExecutor */
/** @template [R=unknown] @typedef {import('@endo/eventual-send').RemoteKit<R>} RemoteKit */

// Your app may need to `import '@endo/eventual-send/shim.js'` to get HandledPromise

// This logic was mostly lifted from @agoric/swingset-vat liveSlots.js
// Defects in it are mfig's fault.
//
// @ts-ignore We actually mean the function, not the type,
// but TS somehow no longer knows that -- following the extraction
// of @endo/pass-style from @endo/marshal.
// We're using @ts-ignore here because TS is inconsistent about whether this
// line is an error. It is not locally, but it is under CI.
import { Remotable, Far, makeMarshal, QCLASS } from '@endo/marshal';
import { E, HandledPromise } from '@endo/eventual-send';
import { isPromise, makePromiseKit } from '@endo/promise-kit';

import { makeTrap } from './trap.js';

import './types.js';
import { makeFinalizingMap } from './finalize.js';

export { E };

const { details: X, Fail } = assert;

/**
 * @param {any} maybeThenable
 * @returns {boolean}
 */
const isThenable = maybeThenable =>
  maybeThenable && typeof maybeThenable.then === 'function';

/**
 * Reverse slot direction.
 *
 * Reversed to prevent namespace collisions between slots we
 * allocate and the ones the other side allocates.  If we allocate
 * a slot, serialize it to the other side, and they send it back to
 * us, we need to reference just our own slot, not one from their
 * side.
 *
 * @param {CapTPSlot} slot
 * @returns {CapTPSlot} slot with direction reversed
 */
const reverseSlot = slot => {
  const otherDir = slot[1] === '+' ? '-' : '+';
  const revslot = `${slot[0]}${otherDir}${slot.slice(2)}`;
  return revslot;
};

/**
 * @typedef {Object} CapTPOptions the options to makeCapTP
 * @property {(val: unknown, slot: CapTPSlot) => void} [exportHook]
 * @property {(val: unknown, slot: CapTPSlot) => void} [importHook]
 * @property {(err: any) => void} [onReject]
 * @property {number} [epoch] an integer tag to attach to all messages in order to
 * assist in ignoring earlier defunct instance's messages
 * @property {TrapGuest} [trapGuest] if specified, enable this CapTP (guest) to
 * use Trap(target) to block while the recipient (host) resolves and
 * communicates the response to the message
 * @property {TrapHost} [trapHost] if specified, enable this CapTP (host) to serve
 * objects marked with makeTrapHandler to synchronous clients (guests)
 */

/**
 * Create a CapTP connection.
 *
 * @param {string} ourId our name for the current side
 * @param {(obj: Record<string, any>) => void} rawSend send a JSONable packet
 * @param {any} bootstrapObj the object to export to the other side
 * @param {CapTPOptions} opts options to the connection
 */
export const makeCapTP = (
  ourId,
  rawSend,
  bootstrapObj = undefined,
  opts = {},
) => {
  const sendCount = {};
  const recvCount = {};
  const getStats = () =>
    harden({
      sendCount: { ...sendCount },
      recvCount: { ...recvCount },
    });

  const {
    onReject = err => console.error('CapTP', ourId, 'exception:', err),
    epoch = 0,
    exportHook,
    importHook,
    trapGuest,
    trapHost,
  } = opts;

  // It's a hazard to have trapGuest and trapHost both enabled, as we may
  // encounter deadlock.  Without a lot more bookkeeping, we can't detect it for
  // more general networks of CapTPs, but we are conservative for at least this
  // one case.
  !(trapHost && trapGuest) ||
    Fail`CapTP ${ourId} can only be one of either trapGuest or trapHost`;

  const disconnectReason = id =>
    Error(`${JSON.stringify(id)} connection closed`);

  /** @type {Map<string, Promise<IteratorResult<void, void>>>} */
  const trapIteratorResultP = new Map();
  /** @type {Map<string, AsyncIterator<void, void, any>>} */
  const trapIterator = new Map();

  /** @type {any} */
  let unplug = false;
  const quietReject = async (reason = undefined, returnIt = true) => {
    if ((unplug === false || reason !== unplug) && reason !== undefined) {
      onReject(reason);
    }
    if (!returnIt) {
      return Promise.resolve();
    }

    // Silence the unhandled rejection warning, but don't affect
    // the user's handlers.
    const p = Promise.reject(reason);
    p.catch(_ => {});
    return p;
  };

  /**
   * @param {Record<string, any>} obj
   */
  const send = obj => {
    sendCount[obj.type] = (sendCount[obj.type] || 0) + 1;
    // Don't throw here if unplugged, just don't send.
    if (unplug === false) {
      rawSend(obj);
    }
  };

  /**
   * convertValToSlot and convertSlotToVal both perform side effects,
   * populating the c-lists (imports/exports/questions/answers) upon
   * marshalling/unmarshalling.  As we traverse the datastructure representing
   * the message, we discover what we need to import/export and send relevant
   * messages across the wire.
   */
  const { serialize, unserialize } = makeMarshal(
    // eslint-disable-next-line no-use-before-define
    convertValToSlot,
    // eslint-disable-next-line no-use-before-define
    convertSlotToVal,
    {
      marshalName: `captp:${ourId}`,
      // TODO Temporary hack.
      // See https://github.com/Agoric/agoric-sdk/issues/2780
      errorIdNum: 20000,
      // TODO: fix captp to be compatible with smallcaps
      serializeBodyFormat: 'capdata',
    },
  );

  /** @type {WeakMap<any, CapTPSlot>} */
  const valToSlot = new WeakMap(); // exports looked up by val
  const slotToVal = makeFinalizingMap(
    /**
     * @param {CapTPSlot} slot
     */
    slot => {
      const slotID = reverseSlot(slot);
      send({ type: 'CTP_DROP', slotID, epoch });
    },
  );
  const exportedTrapHandlers = new WeakSet();

  // Used to construct slot names for promises/non-promises.
  // In this version of CapTP we use strings for export/import slot names.
  // prefixed with 'p' if promises and 'o' otherwise;
  let lastPromiseID = 0;
  let lastExportID = 0;
  // Since we decide the ids for questions, we use this to increment the
  // question key

  /** @type {Map<CapTPSlot, Settler<unknown>>} */
  const settlers = new Map();
  /** @type {Map<string, any>} */
  const answers = new Map(); // chosen by our peer

  /**
   * Called at marshalling time.  Either retrieves an existing export, or if
   * not yet exported, records this exported object.  If a promise, sets up a
   * promise listener to inform the other side when the promise is
   * fulfilled/broken.
   *
   * @type {import('@endo/marshal').ConvertValToSlot<CapTPSlot>}
   */
  function convertValToSlot(val) {
    if (!valToSlot.has(val)) {
      /**
       * new export
       *
       * @type {CapTPSlot}
       */
      let slot;
      if (isPromise(val)) {
        // This is a promise, so we're going to increment the lastPromiseId
        // and use that to construct the slot name.  Promise slots are prefaced
        // with 'p+'.
        lastPromiseID += 1;
        slot = `p+${lastPromiseID}`;
        const promiseID = reverseSlot(slot);
        if (exportHook) {
          exportHook(val, slot);
        }
        // Set up promise listener to inform other side when this promise
        // is fulfilled/broken
        E.when(
          val,
          res =>
            send({
              type: 'CTP_RESOLVE',
              promiseID,
              res: serialize(harden(res)),
            }),
          rej =>
            send({
              type: 'CTP_RESOLVE',
              promiseID,
              rej: serialize(harden(rej)),
            }),
        );
      } else {
        // Since this isn't a promise, we instead increment the lastExportId and
        // use that to construct the slot name.  Non-promises are prefaced with
        // 'o+' for normal objects, or `t+` for syncable.
        const exportID = lastExportID + 1;
        if (exportedTrapHandlers.has(val)) {
          slot = `t+${exportID}`;
        } else {
          slot = `o+${exportID}`;
        }
        if (exportHook) {
          exportHook(val, slot);
        }
        lastExportID = exportID;
      }

      // Now record the export in both valToSlot and slotToVal so we can look it
      // up from either the value or the slot name later.
      valToSlot.set(val, slot);
      slotToVal.set(slot, val);
    }
    // At this point, the value is guaranteed to be exported, so return the
    // associated slot number.
    const slot = valToSlot.get(val);
    assert.typeof(slot, 'string');

    return slot;
  }

  const IS_REMOTE_PUMPKIN = harden({});
  /**
   * @type {import('@endo/marshal').ConvertSlotToVal<CapTPSlot>}
   */
  const assertValIsLocal = val => {
    const slot = valToSlot.get(val);
    if (slot && slot[1] === '-') {
      throw IS_REMOTE_PUMPKIN;
    }
  };

  const { serialize: assertOnlyLocal } = makeMarshal(assertValIsLocal);
  const isOnlyLocal = specimen => {
    // Try marshalling the object, but throw on references to remote objects.
    try {
      assertOnlyLocal(harden(specimen));
      return true;
    } catch (e) {
      if (e === IS_REMOTE_PUMPKIN) {
        return false;
      }
      throw e;
    }
  };

  /**
   * Generate a new question in the questions table and set up a new
   * remote handled promise.
   *
   * @returns {[string, Promise]}
   */
  const makeQuestion = () => {
    lastPromiseID += 1;
    const slotID = `q-${lastPromiseID}`;

    // eslint-disable-next-line no-use-before-define
    const { promise, settler } = makeRemoteKit(slotID);
    settlers.set(slotID, settler);

    // To fix #2846:
    // We return 'p' to the handler, and the eventual resolution of 'p' will
    // be used to resolve the caller's Promise, but the caller never sees 'p'
    // itself. The caller got back their Promise before the handler ever got
    // invoked, and thus before queueMessage was called. If that caller
    // passes the Promise they received as argument or return value, we want
    // it to serialize as resultVPID. And if someone passes resultVPID to
    // them, we want the user-level code to get back that Promise, not 'p'.
    valToSlot.set(promise, slotID);
    slotToVal.set(slotID, promise);

    return [slotID, promise];
  };

  /**
   * @template [T=unknown]
   * @param {string} target
   * @returns {RemoteKit<T>}
   * Make a remote promise for `target` (an id in the questions table)
   */
  const makeRemoteKit = target => {
    /**
     * This handler is set up such that it will transform both
     * attribute access and method invocation of this remote promise
     * as also being questions / remote handled promises
     *
     * @type {import('@endo/eventual-send').EHandler<{}>}
     */
    const handler = {
      get(_o, prop) {
        if (unplug !== false) {
          return quietReject(unplug);
        }
        const [questionID, promise] = makeQuestion();
        send({
          type: 'CTP_CALL',
          epoch,
          questionID,
          target,
          method: serialize(harden([prop])),
        });
        return promise;
      },
      applyFunction(_o, args) {
        if (unplug !== false) {
          return quietReject(unplug);
        }
        const [questionID, promise] = makeQuestion();
        send({
          type: 'CTP_CALL',
          epoch,
          questionID,
          target,
          method: serialize(harden([null, args])),
        });
        return promise;
      },
      applyMethod(_o, prop, args) {
        if (unplug !== false) {
          return quietReject(unplug);
        }
        // Support: o~.[prop](...args) remote method invocation
        const [questionID, promise] = makeQuestion();
        send({
          type: 'CTP_CALL',
          epoch,
          questionID,
          target,
          method: serialize(harden([prop, args])),
        });
        return promise;
      },
    };

    /** @type {Settler<T> | undefined} */
    let settler;

    /** @type {import('@endo/eventual-send').HandledExecutor<T>} */
    const executor = (resolve, reject, resolveWithPresence) => {
      const s = Far('settler', {
        resolve,
        reject,
        resolveWithPresence: () => resolveWithPresence(handler),
      });
      settler = s;
    };

    const promise = new HandledPromise(executor, handler);
    assert(settler);

    // Silence the unhandled rejection warning, but don't affect
    // the user's handlers.
    promise.catch(e => quietReject(e, false));

    return harden({ promise, settler });
  };

  /**
   * Set up import
   *
   * @type {import('@endo/marshal').ConvertSlotToVal<CapTPSlot>}
   */
  function convertSlotToVal(theirSlot, iface = undefined) {
    let val;
    const slot = reverseSlot(theirSlot);

    if (!slotToVal.has(slot)) {
      // Make a new handled promise for the slot.
      const { promise, settler } = makeRemoteKit(slot);
      if (slot[0] === 'o' || slot[0] === 't') {
        if (iface === undefined) {
          iface = `Alleged: Presence ${ourId} ${slot}`;
        }
        // A new remote presence
        // Use Remotable rather than Far to make a remote from a presence
        //
        // @ts-ignore We actually mean the function, not the type,
        // but TS somehow no longer knows that -- following the extraction
        // of @endo/pass-style from @endo/marshal.
        val = Remotable(iface, undefined, settler.resolveWithPresence());
        if (importHook) {
          importHook(val, slot);
        }
      } else {
        val = promise;
        if (importHook) {
          importHook(val, slot);
        }
        // A new promise
        settlers.set(slot, settler);
      }
      slotToVal.set(slot, val);
      valToSlot.set(val, slot);
    }
    return slotToVal.get(slot);
  }

  // Message handler used for CapTP dispatcher
  const handler = {
    // Remote is asking for bootstrap object
    async CTP_BOOTSTRAP(obj) {
      const { questionID } = obj;
      const bootstrap =
        typeof bootstrapObj === 'function' ? bootstrapObj(obj) : bootstrapObj;
      E.when(bootstrap, bs => {
        // console.log('sending bootstrap', bs);
        answers.set(questionID, bs);
        send({
          type: 'CTP_RETURN',
          epoch,
          answerID: questionID,
          result: serialize(bs),
        });
      });
    },
    async CTP_DROP(obj) {
      const { slotID } = obj;
      slotToVal.delete(slotID);
      answers.delete(slotID);
    },
    // Remote is invoking a method or retrieving a property.
    async CTP_CALL(obj) {
      // questionId: Remote promise (for promise pipelining) this call is
      //   to fulfill
      // target: Slot id of the target to be invoked.  Checks against
      //   answers first; otherwise goes through unserializer
      const { questionID, target, trap } = obj;

      const [prop, args] = unserialize(obj.method);
      let val;
      if (answers.has(target)) {
        val = answers.get(target);
      } else {
        val = unserialize({
          body: JSON.stringify({
            [QCLASS]: 'slot',
            index: 0,
          }),
          slots: [target],
        });
      }

      /** @type {(isReject: boolean, value: any) => void} */
      let processResult = (isReject, value) => {
        // Serialize the result.
        let serial;
        try {
          serial = serialize(harden(value));
        } catch (error) {
          // Promote serialization errors to rejections.
          isReject = true;
          serial = serialize(harden(error));
        }

        send({
          type: 'CTP_RETURN',
          epoch,
          answerID: questionID,
          [isReject ? 'exception' : 'result']: serial,
        });
      };
      if (trap) {
        exportedTrapHandlers.has(val) ||
          Fail`Refused Trap(${val}) because target was not registered with makeTrapHandler`;
        assert.typeof(
          trapHost,
          'function',
          X`CapTP cannot answer Trap(${val}) without a trapHost function`,
        );

        // We need to create a promise for the "isDone" iteration right now to
        // prevent a race with the other side.
        const resultPK = makePromiseKit();
        trapIteratorResultP.set(questionID, resultPK.promise);

        processResult = async (isReject, value) => {
          const serialized = serialize(harden(value));
          const ait = trapHost([isReject, serialized]);
          if (!ait) {
            // One-shot, no async iterator.
            resultPK.resolve({ done: true });
            return;
          }

          // We're ready for them to drive the iterator.
          trapIterator.set(questionID, ait);
          resultPK.resolve({ done: false });
        };
      }

      // If `args` is supplied, we're applying a method or function...
      // otherwise this is property access
      let hp;
      if (!args) {
        hp = HandledPromise.get(val, prop);
      } else if (prop === null) {
        hp = HandledPromise.applyFunction(val, args);
      } else {
        hp = HandledPromise.applyMethod(val, prop, args);
      }

      // Answer with our handled promise
      answers.set(questionID, hp);

      // We let rejections bubble up to our caller, `dispatch`.
      await hp
        // Process this handled promise method's result when settled.
        .then(
          fulfilment => processResult(false, fulfilment),
          reason => processResult(true, reason),
        );
    },
    // Have the host serve more of the reply.
    CTP_TRAP_ITERATE: async obj => {
      trapHost || Fail`CTP_TRAP_ITERATE is impossible without a trapHost`;
      const { questionID, serialized } = obj;

      const resultP = trapIteratorResultP.get(questionID);
      resultP || Fail`CTP_TRAP_ITERATE did not expect ${questionID}`;

      const [method, args] = unserialize(serialized);

      const getNextResultP = async () => {
        const result = await resultP;

        // Done with this trap iterator.
        const cleanup = () => {
          trapIterator.delete(questionID);
          trapIteratorResultP.delete(questionID);
          return harden({ done: true });
        };

        // We want to ensure we clean up the iterator in case of any failure.
        try {
          if (!result || result.done) {
            return cleanup();
          }

          const ait = trapIterator.get(questionID);
          if (!ait) {
            // The iterator is done, so we're done.
            return cleanup();
          }

          // Drive the next iteration.
          return await ait[method](...args);
        } catch (e) {
          cleanup();
          if (!e) {
            Fail`trapGuest expected trapHost AsyncIterator(${questionID}) to be done, but it wasn't`;
          }
          assert.note(e, X`trapHost AsyncIterator(${questionID}) threw`);
          throw e;
        }
      };

      // Store the next result promise.
      const nextResultP = getNextResultP();
      trapIteratorResultP.set(questionID, nextResultP);

      // Ensure that our caller handles any rejection.
      await nextResultP;
    },
    // Answer to one of our questions.
    async CTP_RETURN(obj) {
      const { result, exception, answerID } = obj;
      const settler = settlers.get(answerID);
      if (!settler) {
        throw new Error(
          `Got an answer to a question we have not asked. (answerID = ${answerID} )`,
        );
      }
      settlers.delete(answerID);
      if ('exception' in obj) {
        settler.reject(unserialize(exception));
      } else {
        settler.resolve(unserialize(result));
      }
    },
    // Resolution to an imported promise
    async CTP_RESOLVE(obj) {
      const { promiseID, res, rej } = obj;
      const settler = settlers.get(promiseID);
      if (!settler) {
        // Not a promise we know about; maybe it was collected?
        throw new Error(
          `Got a resolvement of a promise we have not imported. (promiseID = ${promiseID} )`,
        );
      }
      settlers.delete(promiseID);
      if ('rej' in obj) {
        settler.reject(unserialize(rej));
      } else {
        settler.resolve(unserialize(res));
      }
    },
    // The other side has signaled something has gone wrong.
    // Pull the plug!
    async CTP_DISCONNECT(obj) {
      const { reason = disconnectReason(ourId) } = obj;
      if (unplug === false) {
        // Reject with the original reason.
        quietReject(obj.reason, false);
        unplug = reason;
        // Deliver the object, even though we're unplugged.
        rawSend(obj);
      }
      // We no longer wish to subscribe to object finalization.
      slotToVal.clearWithoutFinalizing();
      for (const settler of settlers.values()) {
        settler.reject(reason);
      }
    },
  };

  // Get a reference to the other side's bootstrap object.
  const getBootstrap = async () => {
    if (unplug !== false) {
      return quietReject(unplug);
    }
    const [questionID, promise] = makeQuestion();
    send({
      type: 'CTP_BOOTSTRAP',
      epoch,
      questionID,
    });
    return harden(promise);
  };
  harden(handler);

  // Return a dispatch function.
  const dispatch = obj => {
    try {
      recvCount[obj.type] = (recvCount[obj.type] || 0) + 1;
      if (unplug !== false) {
        return false;
      }
      const fn = handler[obj.type];
      if (fn) {
        fn(obj).catch(e => quietReject(e, false));
        return true;
      }
      return false;
    } catch (e) {
      quietReject(e, false);
      return false;
    }
  };

  // Abort a connection.
  const abort = (reason = undefined) => {
    dispatch({ type: 'CTP_DISCONNECT', epoch, reason });
  };

  const makeTrapHandler = (name, obj) => {
    const far = Far(name, obj);
    exportedTrapHandlers.add(far);
    return far;
  };

  // Put together our return value.
  const rets = {
    abort,
    dispatch,
    getBootstrap,
    getStats,
    isOnlyLocal,
    serialize,
    unserialize,
    makeTrapHandler,
    Trap: /** @type {Trap | undefined} */ (undefined),
  };

  if (trapGuest) {
    assert.typeof(trapGuest, 'function', X`opts.trapGuest must be a function`);

    // Create the Trap proxy maker.
    const makeTrapImpl =
      implMethod =>
      (target, ...implArgs) => {
        Promise.resolve(target) !== target ||
          Fail`Trap(${target}) target cannot be a promise`;

        const slot = valToSlot.get(target);
        // TypeScript confused about `||` control flow so use `if` instead
        // https://github.com/microsoft/TypeScript/issues/50739
        if (!(slot && slot[1] === '-')) {
          Fail`Trap(${target}) target was not imported`;
        }
        // @ts-expect-error TypeScript confused by `Fail` too?
        slot[0] === 't' ||
          Fail`Trap(${target}) imported target was not created with makeTrapHandler`;

        // Send a "trap" message.
        lastPromiseID += 1;
        const questionID = `q-${lastPromiseID}`;

        // Encode the "method" parameter of the CTP_CALL.
        let method;
        switch (implMethod) {
          case 'get': {
            const [prop] = implArgs;
            method = serialize(harden([prop]));
            break;
          }
          case 'applyFunction': {
            const [args] = implArgs;
            method = serialize(harden([null, args]));
            break;
          }
          case 'applyMethod': {
            const [prop, args] = implArgs;
            method = serialize(harden([prop, args]));
            break;
          }
          default: {
            Fail`Internal error; unrecognized implMethod ${implMethod}`;
          }
        }

        // Set up the trap call with its identifying information and a way to send
        // messages over the current CapTP data channel.
        const [isException, serialized] = trapGuest({
          trapMethod: implMethod,
          // @ts-expect-error TypeScript confused by `Fail` too?
          slot,
          trapArgs: implArgs,
          startTrap: () => {
            // Send the call metadata over the connection.
            send({
              type: 'CTP_CALL',
              epoch,
              trap: true, // This is the magic marker.
              questionID,
              target: slot,
              method,
            });

            // Return an IterationObserver.
            const makeIteratorMethod =
              (iteratorMethod, done) =>
              (...args) => {
                send({
                  type: 'CTP_TRAP_ITERATE',
                  epoch,
                  questionID,
                  serialized: serialize(harden([iteratorMethod, args])),
                });
                return harden({ done, value: undefined });
              };
            return harden({
              next: makeIteratorMethod('next', false),
              return: makeIteratorMethod('return', true),
              throw: makeIteratorMethod('throw', true),
            });
          },
        });

        const value = unserialize(serialized);
        !isThenable(value) ||
          Fail`Trap(${target}) reply cannot be a Thenable; have ${value}`;

        if (isException) {
          throw value;
        }
        return value;
      };

    /** @type {TrapImpl} */
    const trapImpl = {
      applyFunction: makeTrapImpl('applyFunction'),
      applyMethod: makeTrapImpl('applyMethod'),
      get: makeTrapImpl('get'),
    };
    harden(trapImpl);

    rets.Trap = makeTrap(trapImpl);
  }

  return harden(rets);
};
