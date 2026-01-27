# auth

Authentication and account management

## Usage

```bash
Usage: nemar auth [options] [command]

Authentication management

Options:
  -h, --help           display help for command

Commands:
  login [options]      Authenticate with your NEMAR API key
  signup               Register for a new NEMAR account
  status [options]     Check current authentication status
  whoami [options]     Show current user (alias for status)
  logout [options]     Clear stored credentials
  resend-verification  Resend email verification link
  setup-ssh [options]  Configure SSH access for GitHub (auto-generates key)
  help [command]       display help for command

Description:
  Manage your NEMAR account authentication. New users must register, verify
  their email, and be approved by an admin before they can upload datasets.

Workflow:
  1. nemar auth signup     - Register a new account
  2. Verify your email     - Click the link in the verification email
  3. Wait for approval     - Admin will review your request
  4. nemar auth login      - Log in with your API key (sent after approval)

Examples:
  $ nemar auth signup                    # Start registration
  $ nemar auth login                     # Interactive login
  $ nemar auth login -k <api-key>        # Login with API key
  $ nemar auth status --refresh          # Check authentication status
  $ nemar auth whoami                    # Alias for status
  $ nemar auth logout                    # Clear credentials
```

## Subcommands

### auth login

```bash
Usage: nemar auth login [options]

Authenticate with your NEMAR API key

Options:
  -k, --key <key>  API key (alternative: set NEMAR_API_KEY env var)
  -y, --yes        Skip confirmation and proceed
  -n, --no         Skip confirmation and decline
  -h, --help       display help for command

Environment Variables:
  NEMAR_API_KEY    Your API key (alternative to -k flag)

Examples:
  $ nemar auth login                     # Interactive prompt
  $ nemar auth login -k nemar_abc123...  # Provide key directly
  $ NEMAR_API_KEY=nemar_abc... nemar auth login
```

### auth signup

```bash
Usage: nemar auth signup [options]

Register for a new NEMAR account

Options:
  -h, --help  display help for command
```

### auth status

```bash
Usage: nemar auth status [options]

Check current authentication status

Options:
  --refresh   Refresh user info from server
  -h, --help  display help for command
```

### auth logout

```bash
Usage: nemar auth logout [options]

Clear stored credentials

Options:
  -y, --yes   Skip confirmation and proceed
  -n, --no    Skip confirmation and decline
  -h, --help  display help for command
```

### auth resend-verification

```bash
Usage: nemar auth resend-verification [options]

Resend email verification link

Options:
  -h, --help  display help for command
```

### auth setup-ssh

```bash
Usage: nemar auth setup-ssh [options]

Configure SSH access for GitHub (auto-generates key)

Options:
  -f, --force  Regenerate SSH key even if one exists
  -h, --help   display help for command

Description:
  Automatically configures SSH access for GitHub, which is required
  for uploading datasets. This command will:

  1. Generate a dedicated Ed25519 SSH key for NEMAR (~/.ssh/nemar_ed25519)
  2. Configure SSH to use this key for GitHub
  3. Register the key with your GitHub account (via NEMAR backend)

  This is a one-time setup. After running this command, you can upload
  datasets without any manual SSH configuration.

Examples:
  $ nemar auth setup-ssh          # Set up SSH access
  $ nemar auth setup-ssh --force  # Regenerate key even if exists
```

