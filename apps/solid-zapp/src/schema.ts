// These data structures define your client-side schema.
// They must be equal to or a subset of the server-side schema.
// Note the "relationships" field, which defines first-class
// relationships between tables.
// See https://github.com/rocicorp/mono/blob/main/apps/zbugs/src/domain/schema.ts
// for more complex examples, including many-to-many.

import { SchemaToRow } from "@rocicorp/zero";

const userSchema = {
  tableName: "user",
  columns: {
    id: { type: "string" },
    name: { type: "string" },
    partner: { type: "boolean" },
  },
  primaryKey: ["id"],
  relationships: {},
} as const;

const mediumSchema = {
  tableName: "medium",
  columns: {
    id: { type: "string" },
    name: { type: "string" },
  },
  primaryKey: ["id"],
  relationships: {},
} as const;

const messageSchema = {
  tableName: "message",
  columns: {
    id: { type: "string" },
    senderID: { type: "string" },
    mediumID: { type: "string" },
    body: { type: "string" },
    timestamp: { type: "number" },
  },
  primaryKey: ["id"],
  relationships: {
    sender: {
      source: "senderID",
      dest: {
        schema: () => userSchema,
        field: "id",
      },
    },
    medium: {
      source: "mediumID",
      dest: {
        schema: () => mediumSchema,
        field: "id",
      },
    },
  },
} as const;

export const schema = {
  version: 1,
  tables: {
    user: userSchema,
    medium: mediumSchema,
    message: messageSchema,
  },
} as const;

export type Schema = typeof schema;
export type Message = SchemaToRow<typeof schema.tables.message>;
export type Medium = SchemaToRow<typeof schema.tables.medium>;
export type User = SchemaToRow<typeof schema.tables.user>;
