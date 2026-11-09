# Activation and recovery contract

The inventory helper supplies an offline evidence check. Implement the following operations using the actual service manager, orchestrator and queue APIs.

| Operation | Required evidence |
| --- | --- |
| Capture | Current image/revision, normalized env and mounts, source digests, queue pause state |
| Prepare | Exclusive release ownership, reviewed manifest, old images and backup locations |
| Drain | Pause only queues that this release paused, bounded wait for active work |
| Apply | Fresh expected-before checks at every write, atomic file replacement where appropriate |
| Activate | Coordinated update of services sharing a changed contract |
| Verify | Installed digests, readiness, feature requests and restored queue states |
| Recover | Previous runtime and source versions, preserved concurrent changes, recovery receipt |

Queue restoration belongs inside the success transaction. A failure restoring queues must take the recovery path even after readiness succeeded. Re-pause owned queues and attempt a bounded drain if a partial resume allowed new work. Initially paused queues retain their state.

Readiness checks must exercise the running service through its normal route. Importing an application bootstrap just to inspect a constant may start workers, open databases or contact providers. Prefer isolated exports or inspect file hashes for that purpose.

Inspect file bind mounts before replacing configuration files. Some runtimes continue reading an old inode after an atomic host-side rename of a single mounted file. Use the runtime's supported configuration update procedure and verify the bytes it sees.

For source comparisons, a hash check immediately followed by a write still assumes exclusive source ownership. Use a deployment lock and exclude other writers. A receipt must state this assumption if the underlying filesystem offers no atomic compare-and-swap.

If the connection is lost after activation starts, inspect the saved operation state and live identities. Choose continuation or rollback based on that state. Preserve previous evidence and use a distinct recovery receipt for another operation.
