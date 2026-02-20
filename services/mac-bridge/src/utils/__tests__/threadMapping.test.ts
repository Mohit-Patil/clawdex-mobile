import {
  toPreview,
  toRecord,
  readString,
  readNumber,
  unixSecondsToIso,
  mapRawStatus,
  extractLastError,
  toRawThread,
  toRawTurn,
} from '../threadMapping';

// ---------------------------------------------------------------------------
// toPreview
// ---------------------------------------------------------------------------

describe('toPreview', () => {
  it('collapses multiple whitespace and newlines into single spaces', () => {
    expect(toPreview('hello   world\nfoo')).toBe('hello world foo');
  });

  it('truncates strings longer than 180 chars to 177 + "..."', () => {
    const long = 'a'.repeat(200);
    const result = toPreview(long);
    expect(result.length).toBe(180);
    expect(result).toBe('a'.repeat(177) + '...');
  });

  it('returns short strings unchanged', () => {
    expect(toPreview('hello')).toBe('hello');
  });

  it('returns a 180-char string unchanged (boundary)', () => {
    const exact = 'b'.repeat(180);
    expect(toPreview(exact)).toBe(exact);
  });

  it('trims leading and trailing whitespace', () => {
    expect(toPreview('  hello  ')).toBe('hello');
  });
});

// ---------------------------------------------------------------------------
// toRecord
// ---------------------------------------------------------------------------

describe('toRecord', () => {
  it('returns plain objects as-is', () => {
    const obj = { a: 1, b: 'two' };
    expect(toRecord(obj)).toBe(obj);
  });

  it('returns null for a string', () => {
    expect(toRecord('hello')).toBeNull();
  });

  it('returns null for a number', () => {
    expect(toRecord(42)).toBeNull();
  });

  it('returns null for a boolean', () => {
    expect(toRecord(true)).toBeNull();
  });

  it('returns null for null', () => {
    expect(toRecord(null)).toBeNull();
  });

  it('returns null for undefined', () => {
    expect(toRecord(undefined)).toBeNull();
  });

  it('returns arrays as objects (typeof [] === "object")', () => {
    const arr = [1, 2, 3];
    // Arrays pass the typeof === 'object' && !== null check
    expect(toRecord(arr)).toBe(arr);
  });
});

// ---------------------------------------------------------------------------
// readString
// ---------------------------------------------------------------------------

describe('readString', () => {
  it('returns string input unchanged', () => {
    expect(readString('hello')).toBe('hello');
  });

  it('returns empty string unchanged', () => {
    expect(readString('')).toBe('');
  });

  it('returns null for a number', () => {
    expect(readString(42)).toBeNull();
  });

  it('returns null for an object', () => {
    expect(readString({ a: 1 })).toBeNull();
  });

  it('returns null for null', () => {
    expect(readString(null)).toBeNull();
  });

  it('returns null for undefined', () => {
    expect(readString(undefined)).toBeNull();
  });

  it('returns null for a boolean', () => {
    expect(readString(true)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// readNumber
// ---------------------------------------------------------------------------

describe('readNumber', () => {
  it('returns finite numbers', () => {
    expect(readNumber(42)).toBe(42);
    expect(readNumber(-3.14)).toBe(-3.14);
    expect(readNumber(0)).toBe(0);
  });

  it('returns null for NaN', () => {
    expect(readNumber(NaN)).toBeNull();
  });

  it('returns null for Infinity', () => {
    expect(readNumber(Infinity)).toBeNull();
  });

  it('returns null for -Infinity', () => {
    expect(readNumber(-Infinity)).toBeNull();
  });

  it('returns null for a string', () => {
    expect(readNumber('42')).toBeNull();
  });

  it('returns null for null', () => {
    expect(readNumber(null)).toBeNull();
  });

  it('returns null for undefined', () => {
    expect(readNumber(undefined)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// unixSecondsToIso
// ---------------------------------------------------------------------------

describe('unixSecondsToIso', () => {
  it('converts 1700000000 to the expected ISO string', () => {
    expect(unixSecondsToIso(1700000000)).toBe('2023-11-14T22:13:20.000Z');
  });

  it('converts 0 to the Unix epoch ISO string', () => {
    expect(unixSecondsToIso(0)).toBe('1970-01-01T00:00:00.000Z');
  });

  it('returns a valid ISO string for undefined (falls back to current time)', () => {
    const result = unixSecondsToIso(undefined);
    // Should be a valid ISO date string, not throw
    expect(() => new Date(result)).not.toThrow();
    expect(new Date(result).toISOString()).toBe(result);
  });

  it('returns a valid ISO string for NaN (falls back to current time)', () => {
    const result = unixSecondsToIso(NaN);
    expect(() => new Date(result)).not.toThrow();
    expect(new Date(result).toISOString()).toBe(result);
  });
});

// ---------------------------------------------------------------------------
// mapRawStatus
// ---------------------------------------------------------------------------

describe('mapRawStatus', () => {
  it('returns "running" for { type: "active" }', () => {
    expect(mapRawStatus({ type: 'active' }, undefined)).toBe('running');
  });

  it('returns "error" for { type: "systemError" }', () => {
    expect(mapRawStatus({ type: 'systemError' }, undefined)).toBe('error');
  });

  it('returns "complete" for { type: "idle" } with turns', () => {
    const turns = [{ id: 't1', status: 'completed' }];
    expect(mapRawStatus({ type: 'idle' }, turns)).toBe('complete');
  });

  it('returns "idle" for { type: "idle" } with empty turns', () => {
    expect(mapRawStatus({ type: 'idle' }, [])).toBe('idle');
  });

  it('returns "idle" for { type: "idle" } with no turns', () => {
    expect(mapRawStatus({ type: 'idle' }, undefined)).toBe('idle');
  });

  it('returns "complete" for { type: "notLoaded" } with turns', () => {
    const turns = [{ id: 't1', status: 'completed' }];
    expect(mapRawStatus({ type: 'notLoaded' }, turns)).toBe('complete');
  });

  it('returns "running" when last turn status is "inProgress"', () => {
    const turns = [
      { id: 't1', status: 'completed' },
      { id: 't2', status: 'inProgress' },
    ];
    expect(mapRawStatus({ type: 'idle' }, turns)).toBe('running');
  });

  it('returns "error" when last turn status is "failed"', () => {
    const turns = [{ id: 't1', status: 'failed' }];
    expect(mapRawStatus({ type: 'idle' }, turns)).toBe('error');
  });

  it('returns "error" when last turn status is "interrupted"', () => {
    const turns = [{ id: 't1', status: 'interrupted' }];
    expect(mapRawStatus({ type: 'idle' }, turns)).toBe('error');
  });

  it('returns "complete" when last turn status is "completed"', () => {
    const turns = [{ id: 't1', status: 'completed' }];
    // Note: "idle" status + completed last turn -> lastTurnStatus check fires first
    expect(mapRawStatus({ type: 'idle' }, turns)).toBe('complete');
  });

  it('returns "idle" for null status with no turns', () => {
    expect(mapRawStatus(null, undefined)).toBe('idle');
  });

  it('returns "idle" for undefined status with no turns', () => {
    expect(mapRawStatus(undefined, undefined)).toBe('idle');
  });
});

// ---------------------------------------------------------------------------
// extractLastError
// ---------------------------------------------------------------------------

describe('extractLastError', () => {
  it('returns error message from the last failed turn', () => {
    const turns = [
      { id: 't1', status: 'failed', error: { message: 'something broke' } },
    ];
    expect(extractLastError(turns)).toBe('something broke');
  });

  it('returns "turn failed" when failed turn has no error message', () => {
    const turns = [{ id: 't1', status: 'failed', error: null }];
    expect(extractLastError(turns)).toBe('turn failed');
  });

  it('returns "turn interrupted" for an interrupted turn', () => {
    const turns = [{ id: 't1', status: 'interrupted' }];
    expect(extractLastError(turns)).toBe('turn interrupted');
  });

  it('returns null for an empty array', () => {
    expect(extractLastError([])).toBeNull();
  });

  it('returns null when all turns are completed', () => {
    const turns = [
      { id: 't1', status: 'completed' },
      { id: 't2', status: 'completed' },
    ];
    expect(extractLastError(turns)).toBeNull();
  });

  it('finds the LAST failed turn when scanning from end', () => {
    const turns = [
      { id: 't1', status: 'failed', error: { message: 'first error' } },
      { id: 't2', status: 'completed' },
      { id: 't3', status: 'failed', error: { message: 'last error' } },
    ];
    expect(extractLastError(turns)).toBe('last error');
  });
});

// ---------------------------------------------------------------------------
// toRawThread
// ---------------------------------------------------------------------------

describe('toRawThread', () => {
  it('maps a well-formed object with all fields', () => {
    const input = {
      id: 'thread-1',
      preview: 'Hello world',
      modelProvider: 'openai',
      createdAt: 1700000000,
      updatedAt: 1700001000,
      status: { type: 'idle' },
      cwd: '/home/user',
      source: { kind: 'manual' },
      turns: [
        {
          id: 'turn-1',
          status: 'completed',
          error: null,
          items: [{ type: 'userMessage', id: 'item-1', content: [] }],
        },
      ],
    };

    const result = toRawThread(input);
    expect(result.id).toBe('thread-1');
    expect(result.preview).toBe('Hello world');
    expect(result.modelProvider).toBe('openai');
    expect(result.createdAt).toBe(1700000000);
    expect(result.updatedAt).toBe(1700001000);
    expect(result.status).toEqual({ type: 'idle' });
    expect(result.cwd).toBe('/home/user');
    expect(result.source).toEqual({ kind: 'manual' });
    expect(result.turns).toHaveLength(1);
    expect(result.turns![0].id).toBe('turn-1');
  });

  it('returns safe defaults for null input', () => {
    const result = toRawThread(null);
    expect(result.id).toBeUndefined();
    expect(result.preview).toBeUndefined();
    expect(result.modelProvider).toBeUndefined();
    expect(result.createdAt).toBeUndefined();
    expect(result.updatedAt).toBeUndefined();
    expect(result.status).toBeUndefined();
    expect(result.cwd).toBeUndefined();
    expect(result.source).toBeNull();
    expect(result.turns).toBeUndefined();
  });

  it('returns safe defaults for non-object input', () => {
    const result = toRawThread('not an object');
    expect(result.id).toBeUndefined();
    expect(result.preview).toBeUndefined();
    expect(result.turns).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// toRawTurn
// ---------------------------------------------------------------------------

describe('toRawTurn', () => {
  it('maps a well-formed turn object', () => {
    const input = {
      id: 'turn-1',
      status: 'completed',
      error: { message: 'oops' },
      items: [{ type: 'userMessage', id: 'item-1' }],
    };

    const result = toRawTurn(input);
    expect(result).not.toBeNull();
    expect(result!.id).toBe('turn-1');
    expect(result!.status).toBe('completed');
    expect(result!.error).toEqual({ message: 'oops' });
    expect(result!.items).toHaveLength(1);
    expect(result!.items![0]).toEqual({ type: 'userMessage', id: 'item-1' });
  });

  it('returns null for null input', () => {
    expect(toRawTurn(null)).toBeNull();
  });

  it('returns null for undefined input', () => {
    expect(toRawTurn(undefined)).toBeNull();
  });

  it('returns null for non-object input (string)', () => {
    expect(toRawTurn('not an object')).toBeNull();
  });

  it('returns null for non-object input (number)', () => {
    expect(toRawTurn(42)).toBeNull();
  });

  it('handles turn with no items', () => {
    const result = toRawTurn({ id: 'turn-2', status: 'failed' });
    expect(result).not.toBeNull();
    expect(result!.items).toBeUndefined();
  });

  it('filters out non-object items', () => {
    const input = {
      id: 'turn-3',
      items: [{ type: 'userMessage', id: 'i1' }, 'bad-item', null, 42],
    };
    const result = toRawTurn(input);
    expect(result!.items).toHaveLength(1);
    expect(result!.items![0]).toEqual({ type: 'userMessage', id: 'i1' });
  });
});
