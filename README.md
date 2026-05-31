# ATXP Pool Console

Local ATXP registration and key-pool console.

## Features

- Batch registration from account lines in `email----password----client_id----refresh_token` format.
- Outlook verification mail polling through the configured mail API.
- ATXP Developer connection extraction.
- Local web console for registration tasks, saved sessions, and request monitoring.
- OpenAI-compatible local pool proxy.

## Start

```powershell
npm start
```

Open:

```text
http://localhost:3131
```

The Windows helper `open_atxp_console.ps1` can also start the local console and open the browser.

## Pool Proxy

Default local endpoint:

```text
Base URL: http://localhost:3131/pool/v1
API Key: 123456
```

For deployment or sharing outside your own machine, set a stronger key:

```powershell
$env:POOL_API_KEY="replace-with-a-long-random-key"
npm start
```

## Security Notes

Do not commit runtime session files or account input files. They contain live credentials and tokens.

The repository `.gitignore` excludes:

- `sessions/`
- `accounts.txt`
- `.env*`
- logs and temporary browser preview profiles

Use this tool only in environments where you have permission to automate the relevant accounts and API access.
