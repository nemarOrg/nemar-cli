# Authentication

NEMAR uses API key authentication with an admin approval workflow.

## Workflow Overview

1. **Sign up** - Create an account with your details
2. **Verify email** - Click the link in the verification email
3. **Wait for approval** - Admin reviews your request
4. **Retrieve API key** - Use `nemar auth retrieve-key` with your email and password
5. **Log in** - Use your API key to authenticate

## Creating an Account

```bash
nemar auth signup
```

You'll be prompted for:

| Field | Description |
|-------|-------------|
| Username | 3-30 characters, alphanumeric with - and _ |
| Email | Valid email for verification |
| Password | Minimum 12 characters |
| GitHub Username | Required for PR collaboration |
| ORCID iD | Optional, used for DOI creator metadata |
| Description | Why you need NEMAR access (min 20 chars) |

## Logging In

### Interactive

```bash
nemar auth login
```

### With API Key

```bash
nemar auth login -k nemar_your_api_key_here
```

### Environment Variable

```bash
export NEMAR_API_KEY=nemar_your_api_key_here
nemar auth login
```

## Check Status

```bash
# View cached credentials
nemar auth status

# Refresh from server
nemar auth status --refresh
```

## Log Out

```bash
# Remove the active account
nemar auth logout

# Remove all stored accounts
nemar auth logout --all
```

## Switch Accounts

If you have multiple NEMAR accounts:

```bash
# Interactive account picker
nemar auth switch

# Switch to a specific account
nemar auth switch <username>
```

## Resend Verification Email

If you didn't receive the verification email:

```bash
nemar auth resend-verification
```

## Security Notes

!!! warning "Keep Your API Key Secure"
    - Never commit your API key to version control
    - Use environment variables in scripts
    - Don't share your API key with others

Your API key is linked to:
- Your GitHub Personal Access Token (for repository operations)
- Your S3 credentials (for data upload/download)

If you suspect your key is compromised, regenerate it immediately:

```bash
nemar auth regenerate-key
```

This sends a verification email and revokes the old key upon confirmation.
