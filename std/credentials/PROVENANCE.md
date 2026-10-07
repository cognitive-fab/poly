# std.credentials: provenance

The rules of `std/credentials/grant.poly` were taken from RFC 6749 (OAuth 2.0) and RFC 7009 (OAuth 2.0 token revocation), read on 2026-10-06. poly checks the rules this module encodes, and no other (PT22.2). The provider profiles beside it are described in `providers/PROVENANCE.md`.

## Rules from the RFCs

| Rule in the module | Source | What the source says |
|---|---|---|
| `Callback` sets the scopes (`scopes-only-by-consent`, step property) | https://www.rfc-editor.org/rfc/rfc6749#section-3.3 | "The authorization server MAY fully or partially ignore the scope requested by the client ... If the issued access token scope is different from the one requested by the client, the authorization server MUST include the "scope" response parameter." The scopes are what the holder granted, and may be fewer than requested; only a new consent changes them. |
| `refresh-keeps-scopes` (step property) | https://www.rfc-editor.org/rfc/rfc6749#section-6 | "The requested scope MUST NOT include any scope not originally granted by the resource owner, and if omitted is treated as equal to the scope originally granted by the resource owner." The module refreshes with the scope originally granted. |
| `invalid-grant-expires` (step property) | https://www.rfc-editor.org/rfc/rfc6749#section-5.2 | `invalid_grant`: "The provided authorization grant ... or refresh token is invalid, expired, revoked ... or was issued to another client." A refresh refused this way is not retried: the grant is expired, and only a new authorization renews it. |
| `revoke-revokes-tokens` (step property) | https://www.rfc-editor.org/rfc/rfc7009#section-2 | "If the particular token is a refresh token and the authorization server supports the revocation of access tokens, then the authorization server SHOULD also invalidate all access tokens based on the same authorization grant." A grant that may hold tokens revokes them at the provider (the effect `revoke`), from every state but `Revoked`: one asked again after it was granted is `Requested` and still holds that grant's tokens until the holder answers (review C1, M9). One never granted holds none, and the vault's revocation of no token set does nothing. |
| `Revoked` is terminal | https://www.rfc-editor.org/rfc/rfc7009#section-2.2 | "the token cannot be used again after the revocation". A new grant is a new authorization, not this instance. |

## Constants

| Constant | Source |
|---|---|
| three refresh attempts (`attempt : 0..3`) | poly's own choice (S204): the RFCs set no number. A transient failure of the token endpoint is retried twice more, then the grant expires and the holder is asked again. |
| `retry { attempts 1, base 500ms, timeout 30s }` on `refresh` | poly's own: the machine counts the attempts itself, so the outbox tries each once. `500ms` and `30s` are the outbox's defaults (S137). |

## poly's own rules

| Rule in the module | Why |
|---|---|
| `refresh-bounded` (step property) | A failed refresh is retried until the third attempt, and the third failure expires the grant: the bound in Constants above. |
| `attempt-only-while-refreshing` (invariant) | The attempt counter means something only while a refresh is under way. |
| `refresh-ends` (liveness, under fairness of `Refreshed` or `RefreshFailed`) | AC20: a refresh ends in `Granted`, `Expired` or `Revoked` when the token endpoint eventually answers. |
| `Reauthorize` from `Granted` or `Expired` | The holder is asked again, to widen the scopes or after expiry; the scopes are cleared until the new consent. |

## Not checked

Token lifetimes, the provider's own revocation webhooks and anything a token's bearer does with it at the provider are outside the module: the vault adapter and the provider profile carry them (PT22.3, PT22.6).

## Conclusion

The module encodes the lifecycle of a delegated grant as RFC 6749 and RFC 7009 describe it, with poly's own bound on refresh attempts. Each rule has a source or is listed as poly's own, and each has a seeded mutant in `test/std-credentials.test.mjs`.
