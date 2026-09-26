/** Domain errors can cross the UI/server boundary without exposing file paths. */
export class SequenceError extends Error {
  constructor(
    readonly code: 'INVALID_DOCUMENT' | 'INVALID_TIME' | 'TIME_OVERFLOW' | 'INVALID_RANGE'
      | 'MISSING_TARGET' | 'TRACK_COLLISION' | 'TRANSITION_INTERSECTION' | 'BROKEN_REFERENCE'
      | 'REVISION_CONFLICT' | 'AMBIGUOUS_SOURCE_OCCURRENCE' | 'INAUDIBLE_SOURCE' | 'SPEED_REGISTERED',
    message: string,
    readonly targets: readonly string[] = [],
  ) {
    super(message);
    this.name = 'SequenceError';
  }
}
