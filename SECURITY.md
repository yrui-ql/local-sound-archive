# Security

## Reporting a vulnerability

Please do not open a public issue for security problems. Report them privately
to the repository owner through GitHub Security Advisories or a direct private
message.

## Local data

LSA stores account cookies, library paths and the AI control token in the local
data directory. These files are not part of this repository and must never be
committed.

The repository `.gitignore` excludes:

- `ai-control.json` and its logs;
- local databases and logs;
- build outputs;
- downloaded binary dependencies.

## AI control

The local AI control endpoint is bound to `127.0.0.1`, requires a random local
token, and exposes playback/library actions only. It does not expose file
deletion, shell execution or account credentials.

Disable it from **Settings → AI Control** when not in use.
