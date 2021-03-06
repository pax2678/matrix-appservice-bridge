const log = require("./logging").get("RoomUpgradeHandler");
const MatrixRoom = require("../models/rooms/matrix");
const MatrixUser = require("../models/users/matrix");

/**
 * Handles migration of rooms when a room upgrade is performed.
 */
class RoomUpgradeHandler {
    /**
     * @param {RoomUpgradeHandler~Options} opts
     * @param {Bridge} bridge The parent bridge.
     */
    constructor(opts, bridge) {
        if (opts.migrateGhosts !== false) {
            opts.migrateGhosts = true;
        }
        if (opts.migrateStoreEntries !== false) {
            opts.migrateStoreEntries = true;
        }
        this._opts = opts;
        this._bridge = bridge;
        this._waitingForInvite = new Map(); //newRoomId: oldRoomId
    }

    onTombstone(ev) {
        const movingTo = ev.content.replacement_room;
        log.info(`Got tombstone event for ${ev.room_id} -> ${movingTo}`);
        const joinVia = new MatrixUser(ev.sender).domain;
        // Try to join the new room.
        return this._joinNewRoom(movingTo, [joinVia]).then((couldJoin) => {
            if (couldJoin) {
                return this._onJoinedNewRoom(ev.room_id, movingTo);
            }
            this._waitingForInvite.set(movingTo, ev.room_id);
            return true;
        }).catch((err) => {
            log.error("Couldn't handle room upgrade: ", err);
            return false;
        });
    }

    _joinNewRoom(newRoomId, joinVia=[]) {
        const intent = this._bridge.getIntent();
        return intent.join(newRoomId, [joinVia]).then(() => {
            return true;
        }).catch((ex) => {
            if (ex.errcode === "M_FORBIDDEN") {
                return false;
            }
            throw Error("Failed to handle upgrade");
        })
    }

    onInvite(ev) {
        if (!this._waitingForInvite.has(ev.room_id)) {
            return false;
        }
        const oldRoomId = this._waitingForInvite.get(ev.room_id);
        this._waitingForInvite.delete(ev.room_id);
        log.debug(`Got invite to upgraded room ${ev.room_id}`);
        this._joinNewRoom(ev.room_id).then(() => {
            return this._onJoinedNewRoom(oldRoomId, ev.room_id);
        }).catch((err) => {
            log.error("Couldn't handle room upgrade: ", err);
        });
        return true;
    }

    async _onJoinedNewRoom(oldRoomId, newRoomId) {
        log.debug(`Joined ${newRoomId}`);
        const intent = this._bridge.getIntent();
        const asBot = this._bridge.getBot();
        if (this._opts.migrateStoreEntries) {
            const success = await this._migrateStoreEntries(oldRoomId, newRoomId);
            if (!success) {
                log.error("Failed to migrate room entries. Not continuing with migration.");
                return false;
            }
        }

        log.debug(`Migrated entries from ${oldRoomId} to ${newRoomId} successfully.`);
        if (this._opts.onRoomMigrated) {
            // This may or may not be a promise, so await it.
            await this._opts.onRoomMigrated(oldRoomId, newRoomId);
        }

        if (!this._opts.migrateGhosts) {
            return false;
        }
        try {
            const members = await asBot.getJoinedMembers(oldRoomId);
            const userIds = Object.keys(members).filter((u) => asBot.isRemoteUser(u));
            log.debug(`Migrating ${userIds.length} ghosts`);
            for (const userId of userIds) {
                const i = this._bridge.getIntent(userId);
                await i.leave(oldRoomId);
                await i.join(newRoomId);
            }
            intent.leave(oldRoomId);
        }
        catch (ex) {
            log.warn("Failed to migrate ghosts", ex);
            return false;
        }
        return true;
    }

    async _migrateStoreEntries(oldRoomId, newRoomId) {
        const roomStore = this._bridge.getRoomStore();
        const entries = await roomStore.getEntriesByMatrixId(oldRoomId);
        let success = false;
        // Upgrades are critical to get right, or a room will be stuck
        // until someone manaually intervenes. It's important to continue
        // migrating if at least one entry is successfully migrated.
        for (const entry of entries) {
            log.debug(`Migrating room entry ${entry.id}`);
            const existingId = entry.id;
            try {
                const newEntry = (
                    this._opts.migrateEntry || this._migrateEntry)(entry, newRoomId);

                if (!newEntry) {
                    continue;
                }

                // If migrateEntry changed the id of the room, then ensure
                // that we remove the old one.
                if (existingId !== newEntry.id) {
                    await roomStore.removeEntryById(existingId);
                }
                await roomStore.upsertEntry(newEntry);
                success = true;
            }
            catch (ex) {
                log.error(`Failed to migrate room entry ${entry.id}.`);
            }
        }
        return success;
    }

    _migrateEntry(entry, newRoomId) {
        entry.matrix = new MatrixRoom(newRoomId, {
            name: entry.name,
            topic: entry.topic,
            extras: entry._extras,
        });
        return entry;
    }
}

module.exports = RoomUpgradeHandler;

 /**
  * Options to supply to the {@link RoomUpgradeHandler}.
  * @typedef RoomUpgradeHandler~Options
  * @type {Object}
  * @property {RoomUpgradeHandler~MigrateEntry} migrateEntry Called when
  * the handler wishes to migrate a MatrixRoom entry to a new room_id. If omitted,
  * {@link RoomUpgradeHandler~_migrateEntry} will be used instead.
  * @property {RoomUpgradeHandler~onRoomMigrated} onRoomMigrated This is called
  * when the entries of the room have been migrated, the bridge should do any cleanup it
  * needs of the old room and setup the new room (ex: Joining ghosts to the new room).
  * @property {bool} [consumeEvent=true] Consume tombstone or invite events that
  * are acted on by this handler.
  * @property {bool} [migrateGhosts=true] If true, migrate all ghost users across to
  * the new room.
  * @property {bool} [migrateStoreEntries=true] If true, migrate all ghost users across to
  * the new room.
  */


 /**
 * Invoked when iterating around a rooms entries. Should be used to update entries
 * with a new room id.
 *
 * @callback RoomUpgradeHandler~MigrateEntry
 * @param {RoomBridgeStore~Entry} entry The existing entry.
 * @param {string} newRoomId The new roomId.
 * @return {RoomBridgeStore~Entry} Return the entry to upsert it,
 * or null to ignore it.
 */

 /**
  * Invoked after a room has been upgraded and it's entries updated.
  *
  * @callback RoomUpgradeHandler~onRoomMigrated
  * @param {string} oldRoomId The old roomId.
  * @param {string} newRoomId The new roomId.
  */

