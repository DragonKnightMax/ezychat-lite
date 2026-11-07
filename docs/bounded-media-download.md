# Bounded WhatsApp media downloads

The public `@ezychat/wa` contract adds optional, explicitly detectable hooks:

```ts
import { WaMediaDownloadLimitError, type WaMediaDownloadOptions } from '@ezychat/wa';

const options: WaMediaDownloadOptions = {
  maxBytes: 5 * 1024 * 1024,
  signal: AbortSignal.timeout(15_000),
};
if (!message.media?.downloadBounded) throw new Error('Bounded downloads unavailable');
try {
  const bytes = await message.media.downloadBounded(options);
} catch (error) {
  if (error instanceof WaMediaDownloadLimitError) {
    // error.code === 'media_too_large'; no partial file should be published.
  }
  throw error;
}
```

`adapter.downloadMediaBounded?.(messageId, options)` provides the same guarantee for a
message still in the adapter's raw-message cache. It returns `null` only when that
message is not cached; overflow, cancellation and download errors reject. The byte
limit is a positive safe integer and counts actual decrypted bytes, rather than a
provider's declared length. The collector rejects before retaining an overflowing
chunk or allocating the final buffer, then aborts the upstream request as well as
closing its decrypting stream. The signal also applies while the HTTP request is
being established. The new path verifies the ciphertext HMAC and any supplied plaintext
and encrypted SHA-256 values before returning bytes, restricts media URLs to WhatsApp
HTTPS hosts, and refuses redirects. It uses native fetch because the current Baileys
getHttpStream implementation drops AbortSignal; Baileys public key derivation retains
the same media-specific HKDF inputs. Tests include an actual local HTTP response that
is closed while oversized content is still being streamed.

The fake adapter applies bounds to its already-allocated in-memory fixtures. A
custom `mapWAMessage` legacy downloader is not advertised as bounded unless an
explicit bounded downloader is supplied too.

`download()` and `downloadMedia()` keep their existing behavior. They do not gain a
limit implicitly. The optional method names let callers refuse older packages,
including `@ezychat/wa@0.1.79`, rather than passing an argument an old runtime ignores.

This source change is not a package release. Cloud must keep inbound linked-phone
media gated until a compatible published package version is pinned. No package
version is changed here, no npm publication was performed, and the changed Baileys
path has not been smoke-tested against real WhatsApp.
