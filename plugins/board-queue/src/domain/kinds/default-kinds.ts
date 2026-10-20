import type { Config } from '../config.ts';
import type { ActionKind } from './action-kind.ts';
import { AssigneesKind } from './assignees.ts';
import { CloseKind } from './close.ts';
import { CommentKind } from './comment.ts';
import { KindRegistry } from './registry.ts';
import { SetFieldsKind } from './set-fields.ts';
import { VerifyKind } from './verify.ts';

/** The kinds this system ships with. Teaching it another one starts here. */
export function defaultKinds(config: Config): ActionKind[] {
  return [new SetFieldsKind(config), new VerifyKind(config), new CommentKind(), new CloseKind(), new AssigneesKind()];
}

export function defaultKindRegistry(config: Config): KindRegistry {
  return new KindRegistry(defaultKinds(config));
}
