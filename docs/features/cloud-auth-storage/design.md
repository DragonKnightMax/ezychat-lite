# Durable WhatsApp authentication storage

The optional public `WaAdapterOptions.authStorage` backend replaces local auth files
for hosted consumers. Default desktop behavior still uses `authDir` and Baileys' existing
filesystem store. Hosted consumers provide one isolated store per inbox.

`WaAuthStorage.get` returns serialized values or null for absent records. `set` is an
atomic durable batch, with null values deleting records. `clear` removes the current
inbox's credentials. `backup` creates a durable backup and returns an opaque reference.
Consumers must encrypt stored credentials and keys, enforce isolation, and enforce a
single active owner. No caller-selected namespace, network endpoint or secret is logged.

The package owns Buffer/protobuf conversion and write ordering. Corrupt or unavailable
storage fails closed instead of creating replacement credentials. A process restart
loads the same identity and Signal keys. WhatsApp can still revoke an identity.

Offline tests verify restoration, inbox isolation, protobuf values, deletion, backup,
logout, the public adapter option, credential updates, and persistence failures.
No test contacts WhatsApp or sends a message. This backend remains untested against
real WhatsApp until the cloud pilot is linked with the owner's test number.
