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
  switch [username]    Switch between stored accounts
  logout [options]     Remove the active account (use --all to remove all)
  resend-verification  Resend email verification link
  setup-ssh [options]  Configure SSH access for GitHub (auto-generates key)
  retrieve-key         Retrieve your API key after account approval (requires
                       email and password)
  regenerate-key       Request a new API key (revokes current key, requires
                       email verification)
  help [command]       display help for command

Description:
  Manage your NEMAR account authentication. New users must register, verify
  their email, and be approved by an admin before they can upload datasets.

Workflow:
  1. nemar auth signup         - Register a new account
  2. Verify your email         - Click the link in the verification email
  3. Wait for approval         - Admin will review your request
  4. nemar auth retrieve-key   - Retrieve your API key (requires password)
  5. nemar auth login           - Log in with your API key

Examples:
  $ nemar auth signup                    # Start registration
  $ nemar auth retrieve-key             # Get your API key after approval
  $ nemar auth login                     # Interactive login
  $ nemar auth login -k <api-key>        # Login with API key
  $ nemar auth regenerate-key           # Get a new API key (revokes old)
  $ nemar auth status --refresh          # Check authentication status
  $ nemar auth whoami                    # Alias for status
  $ nemar auth switch                    # Switch between accounts
  $ nemar auth logout                    # Clear active account
  $ nemar auth logout --all              # Clear all accounts
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

### auth whoami

```bash
Usage: nemar auth whoami [options]

Show current user (alias for status)

Options:
  --refresh   Refresh user info from server
  -h, --help  display help for command
```

### auth switch

```bash
Usage: nemar auth switch [options] [username]

Switch between stored accounts

Options:
  -h, --help  display help for command

Description:
  Switch the active NEMAR account. You can specify a NEMAR username or
  GitHub username. If no username is given, an interactive picker is shown.

  Switching also updates the GitHub CLI (gh) to the matching account.

Examples:
  $ nemar auth switch              # Interactive picker
  $ nemar auth switch yahya        # Switch by NEMAR username
  $ nemar auth switch cool-vibers  # Switch by GitHub username
```

### auth logout

```bash
Usage: nemar auth logout [options]

Remove the active account (use --all to remove all)

Options:
  -y, --yes   Skip confirmation and proceed
  -n, --no    Skip confirmation and decline
  --all       Remove all stored accounts
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
  3. Verify the connection (prompts you to add the key to GitHub if needed)

  This is a one-time setup. After running this command and adding the key
  to GitHub, you can upload datasets.

Examples:
  $ nemar auth setup-ssh          # Set up SSH access
  $ nemar auth setup-ssh --force  # Regenerate key even if exists
```

### auth retrieve-key

```bash
Usage: nemar auth retrieve-key [options]

Retrieve your API key after account approval (requires email and password)

Options:
  -h, --help  display help for command

Description:
  After an admin approves your account, use this command to securely
  retrieve your API key. You will need the email and password you used
  during signup.

  API keys are not sent via email for security. This is the only way
  to obtain your key.

Examples:
  $ nemar auth retrieve-key
```

### auth regenerate-key

```bash
Usage: nemar auth regenerate-key [options]

Request a new API key (revokes current key, requires email verification)

Options:
  -h, --help  display help for command

Description:
  If you lost your API key or it was compromised, use this command to
  request a new one. A verification email will be sent to confirm the
  request. Clicking the link will:

  1. Revoke your current API key
  2. Generate a new API key (shown in the browser)
  3. You will need to login again with the new key

Examples:
  $ nemar auth regenerate-key
```

