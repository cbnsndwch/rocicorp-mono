import type {CreateRoomRequest} from 'reflect-protocol';
import {createAuthAPIHeaders} from '../server/auth-api-headers.js';
import {AUTH_ROUTES} from '../server/auth-do.js';
import {CREATE_ROOM_PATH} from '../server/paths.js';
import type {RoomStatus} from '../server/rooms.js';
import {newAuthedPostRequest} from './authedpost.js';

/**
 * createRoom creates a new room with the given roomID. If the room already
 * exists, an error is thrown. This call uses fetch(); you can get a Request
 * using newCreateRoomRequest.
 *
 * @param {string} reflectServerURL - The URL of the reflect server, e.g.
 *   "https://reflect.example.workers.dev".
 * @param {string} authApiKey - The auth API key for the reflect server.
 * @param {string} roomID - The ID of the room to create.
 * @param {string} [jurisdiction] - If 'eu', then the room should be created in the EU.
 *
 *   Do not set this to true unless you are sure you need it.
 */
export async function createRoom(
  reflectServerURL: string,
  authApiKey: string,
  roomID: string,
  jurisdiction?: 'eu',
): Promise<void> {
  const resp = await fetch(
    newCreateRoomRequest(reflectServerURL, authApiKey, roomID, jurisdiction),
  );
  if (!resp.ok) {
    throw new Error(`Failed to create room: ${resp.status} ${resp.statusText}`);
  }
}

export async function closeRoom(
  reflectServerURL: string,
  authApiKey: string,
  roomID: string,
): Promise<void> {
  const resp = await fetch(
    newCloseRoomRequest(reflectServerURL, authApiKey, roomID),
  );
  if (!resp.ok) {
    throw new Error(`Failed to close room: ${resp.status} ${resp.statusText}`);
  }
}

export async function deleteRoom(
  reflectServerURL: string,
  authApiKey: string,
  roomID: string,
): Promise<void> {
  const resp = await fetch(
    newDeleteRoomRequest(reflectServerURL, authApiKey, roomID),
  );
  if (!resp.ok) {
    throw new Error(`Failed to delete room: ${resp.status} ${resp.statusText}`);
  }
}

/**
 * roomStatus returns the status of the room with the given roomID. This call
 * uses fetch(); you can get a Request using newRoomStatusRequest.
 *
 * @param {string} reflectServerURL - The URL of the reflect server, e.g.
 *   "https://reflect.example.workers.dev".
 * @param {string} authApiKey - The auth API key for the reflect server.
 * @param {string} roomID - The ID of the room to return status of.
 *
 * @returns {Promise<RoomStatus>} - The status of the room.
 */
export async function roomStatus(
  reflectServerURL: string,
  authApiKey: string,
  roomID: string,
): Promise<RoomStatus> {
  const resp = await fetch(
    newRoomStatusRequest(reflectServerURL, authApiKey, roomID),
  );
  if (!resp.ok) {
    throw new Error(
      `Failed to get room status: ${resp.status} ${resp.statusText}`,
    );
  }
  return resp.json();
}

/**
 * Returns a new Request for roomStatus.
 *
 * @param {string} reflectServerURL - The URL of the reflect server, e.g.
 *   "https://reflect.example.workers.dev".
 * @param {string} authApiKey - The auth API key for the reflect server.
 * @param {string} roomID - The ID of the room to return status of.
 * @returns {Request} - The Request to get room status.
 */
export function newRoomStatusRequest(
  reflectServerURL: string,
  authApiKey: string,
  roomID: string,
) {
  const path = AUTH_ROUTES.roomStatusByRoomID.replace(
    ':roomID',
    encodeURIComponent(roomID),
  );
  const url = new URL(path, reflectServerURL);
  return new Request(url.toString(), {
    method: 'get',
    headers: createAuthAPIHeaders(authApiKey),
  });
}

/**
 * Returns a new Request for createRoom.
 *
 * @param {string} reflectServerURL - The URL of the reflect server, e.g.
 *   "https://reflect.example.workers.dev".
 * @param {string} authApiKey - The auth API key for the reflect server.
 * @param {string} roomID - The ID of the room to create.
 * @param {string} [jurisdiction] - If 'eu' then the room should be created
 *   in the EU. Do not set this unless you are sure you need it.
 * @returns {Request} - The Request to create the room.
 */
export function newCreateRoomRequest(
  reflectServerURL: string,
  authApiKey: string,
  roomID: string,
  jurisdiction?: 'eu',
) {
  const url = new URL(CREATE_ROOM_PATH, reflectServerURL);
  const req: CreateRoomRequest = {roomID, jurisdiction};
  return newAuthedPostRequest(url, authApiKey, req);
}

export function newCloseRoomRequest(
  reflectServerURL: string,
  authApiKey: string,
  roomID: string,
) {
  const path = AUTH_ROUTES.closeRoom.replace(':roomID', roomID);
  const url = new URL(path, reflectServerURL);
  return newAuthedPostRequest(url, authApiKey);
}

export function newDeleteRoomRequest(
  reflectServerURL: string,
  authApiKey: string,
  roomID: string,
) {
  const path = AUTH_ROUTES.deleteRoom.replace(':roomID', roomID);
  const url = new URL(path, reflectServerURL);
  return newAuthedPostRequest(url, authApiKey);
}
export function newForgetRoomRequest(
  reflectServerURL: string,
  authApiKey: string,
  roomID: string,
) {
  const path = AUTH_ROUTES.forgetRoom.replace(':roomID', roomID);
  const url = new URL(path, reflectServerURL);
  return newAuthedPostRequest(url, authApiKey);
}

export function newMigrateRoomRequest(
  reflectServerURL: string,
  authApiKey: string,
  roomID: string,
) {
  const path = AUTH_ROUTES.migrateRoom.replace(':roomID', roomID);
  const url = new URL(path, reflectServerURL);
  return newAuthedPostRequest(url, authApiKey);
}