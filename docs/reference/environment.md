# Environment Variables

Environment variables for NEMAR CLI configuration.

## Authentication

| Variable | Description | Required |
|----------|-------------|----------|
| `NEMAR_API_KEY` | Your NEMAR API key | For auth |

## API Configuration

| Variable | Description | Default |
|----------|-------------|---------|
| `NEMAR_API_URL` | API base URL | Production API |

## Usage Examples

### In Shell

```bash
export NEMAR_API_KEY=nemar_your_key_here
nemar auth status
```

### In Scripts

```bash
#!/bin/bash
NEMAR_API_KEY=nemar_your_key_here nemar dataset upload ./data
```

### With dotenv

Create a `.env` file (don't commit this!):

```
NEMAR_API_KEY=nemar_your_key_here
```

Then:

```bash
source .env
nemar auth status
```

## CI/CD Usage

### GitHub Actions

```yaml
jobs:
  upload:
    steps:
      - name: Upload dataset
        env:
          NEMAR_API_KEY: ${{ secrets.NEMAR_API_KEY }}
        run: nemar dataset upload ./data
```

## Security

!!! warning "Never Commit Secrets"
    - Add `.env` to `.gitignore`
    - Use secret management in CI/CD
    - Rotate keys if exposed
