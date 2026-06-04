import { describe, expect, it } from 'vitest';
import { TypedEmitter } from '../src/core/emitter.js';

type TestKind = 'ping' | 'pong';
interface TestEvent {
  kind: TestKind;
}

// TypedEmitter's constructor and emit are protected: only a subclass may
// construct one or fan an event out. This subclass widens construction for the
// test, builds the error sink from a captured array (mirroring how
// BatteryMonitor builds its sink from a Logger), and exposes a public fire() so
// a test can drive emit().
class TestEmitter extends TypedEmitter<TestKind, TestEvent> {
  constructor(reported: string[]) {
    super((message) => reported.push(message));
  }

  fire(e: TestEvent): void {
    this.emit(e);
  }
}

describe('TypedEmitter', () => {
  it('runs the remaining listeners for a kind when one listener throws', () => {
    const emitter = new TestEmitter([]);
    const ran: string[] = [];
    emitter.on('ping', () => {
      ran.push('first');
      throw new Error('boom');
    });
    emitter.on('ping', () => {
      ran.push('second');
    });
    emitter.fire({ kind: 'ping' });
    // The throwing first listener must not skip the second one: a broken
    // dispatch listener cannot suppress the state-persist listener.
    expect(ran).toEqual(['first', 'second']);
  });

  it('reports a thrown listener error through the injected sink with the kind and error text', () => {
    const reported: string[] = [];
    const emitter = new TestEmitter(reported);
    emitter.on('pong', () => {
      throw new Error('kaboom');
    });
    emitter.fire({ kind: 'pong' });
    expect(reported).toHaveLength(1);
    expect(reported[0]).toContain('pong');
    expect(reported[0]).toContain('kaboom');
  });

  it('does not invoke the sink when no listener throws', () => {
    const reported: string[] = [];
    const emitter = new TestEmitter(reported);
    let ran = false;
    emitter.on('ping', () => {
      ran = true;
    });
    emitter.fire({ kind: 'ping' });
    expect(ran).toBe(true);
    expect(reported).toEqual([]);
  });

  it('does nothing when an event kind has no listeners', () => {
    const reported: string[] = [];
    const emitter = new TestEmitter(reported);
    // 'pong' was never subscribed: firing it must not throw and must not reach
    // the sink.
    expect(() => emitter.fire({ kind: 'pong' })).not.toThrow();
    expect(reported).toEqual([]);
  });

  it('stops delivering to a listener after its unsubscribe is called', () => {
    const emitter = new TestEmitter([]);
    let count = 0;
    const off = emitter.on('ping', () => {
      count += 1;
    });
    emitter.fire({ kind: 'ping' });
    off();
    emitter.fire({ kind: 'ping' });
    // The second fire lands after unsubscribe, so the listener ran exactly once.
    expect(count).toBe(1);
  });
});
