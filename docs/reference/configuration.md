# Configuration

NEMAR CLI configuration and settings.

## Config File Location

| OS | Path |
|----|------|
| macOS | `~/.config/nemar/config.json` |
| Linux | `~/.config/nemar/config.json` |
| Windows | `%APPDATA%\nemar\config.json` |

## Config Structure

```json
{
  "apiKey": "nemar_...",
  "username": "johndoe",
  "email": "john@example.com",
  "githubUsername": "johndoe"
}
```

## Environment Variables

Environment variables override config file settings:

| Variable | Description |
|----------|-------------|
| `NEMAR_API_KEY` | API key for authentication |
| `NEMAR_API_URL` | API base URL (default: production) |

## Precedence

1. Command-line flags
2. Environment variables
3. Config file
4. Defaults

## Managing Config

### View Config Location

```bash
nemar auth status
# Shows config path
```

### Clear Config

```bash
nemar auth logout
```

### Manual Edit

You can edit the config file directly, but using CLI commands is recommended.
