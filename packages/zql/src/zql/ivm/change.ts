import type {Node, Row} from './data.js';

export type Change = AddChange | RemoveChange | ChildChange;
export type ChangeType = Change['type'];

/**
 * Represents a node (and all its children) getting added to the result.
 */
export type AddChange = {
  type: 'add';
  node: Node;
};

/**
 * Represents a node (and all its children) getting removed from the result.
 */
export type RemoveChange = {
  type: 'remove';
  node: Node;
};

/**
 * The node itself is unchanged, but one of its descendants has changed.
 */
export type ChildChange = {
  type: 'child';
  row: Row;
  child: {
    relationshipName: string;
    change: Change;
  };
};