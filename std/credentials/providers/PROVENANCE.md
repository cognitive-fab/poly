# std/credentials/providers: provenance

A provider profile is data that the checker and the vault adapter both read (PT10e). Each field comes from the provider's own documentation, read on the date the profile records. poly checks what a profile states, and no other property of the provider.

## stripe-connect.json

Read on 2026-10-06 from Stripe's Connect OAuth reference, https://docs.stripe.com/connect/oauth-reference.

| Field | Value | What the source says |
|---|---|---|
| `authorization` | `https://connect.stripe.com/oauth/authorize` | "GET https://connect.stripe.com/oauth/authorize. Sends the user to Stripe to connect to your platform." `response_type`: "The only option at the moment is code." |
| `token` | `https://connect.stripe.com/oauth/token` | "POST https://connect.stripe.com/oauth/token. Used both for turning an authorization_code into an account connection, and for getting a new access token using a refresh_token." |
| `revocation` | `https://connect.stripe.com/oauth/deauthorize` | "POST https://connect.stripe.com/oauth/deauthorize. Used for revoking access to an account." It takes `client_id` and `stripe_user_id`, with the platform's secret key. It is not the RFC 7009 revocation endpoint. |
| `grants` | `authorization_code` | The token endpoint accepts `grant_type` `authorization_code` or `refresh_token`: "The only currently supported types are authorization_code and refresh_token." A refresh is not a grant a credential declares. There is no client credentials grant. |
| `pkce` | `false` | The reference names no `code_challenge` or `code_verifier` parameter. |
| `scopes` | `read_write`, `read_only` | "read_write or read_only, depending on the level of access you need. Defaults to read_only. Note read_only can only be specified for extensions." |
| `bases` | `https://api.stripe.com/` | The API host that calls on behalf of a connected account are made to. |

## What the source says that the profile does not yet model

- **Tokens are deprecated.** The token response's `access_token`, `refresh_token` and `stripe_publishable_key` are marked "(Deprecated)". The reference says to use the `Stripe-Account` header with the platform's secret key instead, which can make requests on behalf of the connected account. A credential of this profile is then the platform's key and the account id, not a token per account. This is brought to the owner (S208, `decisions-m9.md`) before the vault adapter is built.
- **Revocation** is Stripe's `deauthorize`, by account id, for Standard accounts only.

## The test provider

`test/fixtures/std/credentials/providers/test-oauth.json` is the tests' own profile, written from RFC 6749, RFC 7636 (PKCE) and RFC 7009 (revocation). It never ships in `std/`.

## Conclusion

The profile records Stripe Connect's OAuth as documented on the date read. Two of the documented facts, deprecated tokens and a revocation that is not RFC 7009's, are outside what the profile models and are listed for a ruling.
