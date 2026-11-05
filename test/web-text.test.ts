import test from 'node:test';
import assert from 'node:assert/strict';
import { extractUrls, htmlToText, isLocalHostname, isPrivateAddress, wrapPage } from '../src/main/web-text.ts';

test('urls', () => {
  assert.deepEqual(extractUrls('see https://example.com/a, and (http://x.org/b). ftp://no'), ['https://example.com/a', 'http://x.org/b']);
  assert.deepEqual(extractUrls('https://en.wikipedia.org/wiki/Foo_(bar) ok'), ['https://en.wikipedia.org/wiki/Foo_(bar)']);
});

test('private addresses', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1', '0.0.0.0', '100.64.0.1'])
    assert.ok(isPrivateAddress(ip), ip);
  for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700::1111']) assert.ok(!isPrivateAddress(ip), ip);
  assert.ok(isLocalHostname('localhost'));
  assert.ok(isLocalHostname('printer.local'));
  assert.ok(isLocalHostname('intranet'));
  assert.ok(!isLocalHostname('example.com'));
});

test('html to text', () => {
  const html = '<html><head><title>Hi &amp; bye</title><script>alert(1)</script></head><body><nav>menu</nav><h1>Title</h1><p>One <b>two</b></p><ul><li>a</li><li>b</li></ul><style>.x{}</style></body></html>';
  const { title, text } = htmlToText(html);
  assert.equal(title, 'Hi & bye');
  assert.ok(!/alert|menu|\.x/.test(text));
  assert.match(text, /Title\nOne two/);
  assert.match(text, /- a\n- b/);
  assert.match(wrapPage('https://x', 't', 'body'), /UNTRUSTED[\s\S]*<<<page\nbody\npage>>>/);
});
