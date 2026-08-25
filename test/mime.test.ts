import { describe, it, expect } from 'vitest';
import { mimeFor, isAttachment } from '../src/mime.js';
import { sanitizeName } from '../src/upload.js';

describe('mime and names', () => {
  it('maps known extensions', () => {
    expect(mimeFor('x.HTML')).toBe('text/html');
    expect(mimeFor('x.png')).toBe('image/png');
    expect(isAttachment('application/zip')).toBe(true);
  });

  it.each([
    ['../.secret\n.txt', 'secret.txt'],
    [' C:\\temp\\report.pdf ', 'C:tempreport.pdf'],
    ['  ...hidden.txt  ', 'hidden.txt'],
    ['資料/結果.json', '資料結果.json'],
    ['a\u0085b.txt', 'ab.txt'],
    ['////', 'file'],
    ['\u0000\u001f\u007f', 'file'],
  ])('sanitizes %j to %j', (input, expected) => {
    expect(sanitizeName(input)).toBe(expected);
  });
});
