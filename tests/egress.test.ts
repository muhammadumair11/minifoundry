import { expect, test } from 'bun:test'
import { assertPublicHttpUrl } from '../src/lib/egress'

test('connector egress rejects loopback, private addresses, and non-HTTP schemes', async () => {
  for (const url of [
    'http://127.0.0.1/',
    'http://10.1.2.3/',
    'http://169.254.169.254/latest/meta-data/',
    'http://[::1]/',
    'http://[::ffff:7f00:1]/',
    'file:///etc/passwd',
  ]) {
    await expect(assertPublicHttpUrl(url)).rejects.toThrow()
  }
})
