import { describe, expect, it } from 'vitest';
import { normalizeBaseUrl, stripTrailingSlashes } from '../src/core/http.js';

describe('stripTrailingSlashes', () => {
  it('removes a long trailing run without changing embedded slashes', () => {
    expect(stripTrailingSlashes(`http://questdb.local:9000/path${'/'.repeat(100_000)}`)).toBe(
      'http://questdb.local:9000/path',
    );
  });

  it('returns the original value when it has no trailing slash', () => {
    expect(stripTrailingSlashes('http://questdb.local:9000/path')).toBe(
      'http://questdb.local:9000/path',
    );
  });
});

describe('normalizeBaseUrl', () => {
  it('drops credentials, query, fragment, and trailing slashes', () => {
    expect(normalizeBaseUrl(' http://user:pw@qdb.local:9000/base//?q=1#frag ')).toBe(
      'http://qdb.local:9000/base',
    );
  });

  it('returns an unparseable value trimmed, without trailing slashes', () => {
    expect(normalizeBaseUrl(' not a url// ')).toBe('not a url');
  });
});
