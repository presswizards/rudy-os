# Discord Chat Support for Rudy

Rudy now supports receiving messages from Discord and executing tasks autonomously via the Discord Interactions API.

## Overview

The Discord integration allows you to:

1. Send messages to a Discord channel to trigger Rudy workflows
2. Have Rudy execute tasks and reply back to Discord
3. Control access via the Discord bot configuration
4. Run multiple independent Discord channels (via webhook endpoints)

## Setup Steps

### 1. Create a Discord Application

1. Go to [Discord Developer Portal](https://discord.com/developers/applications)
2. Click "New Application" and give it a name (e.g., "Rudy Office")
3. Go to the "Bot" tab and click "Add Bot"
4. Under "TOKEN", click "Copy" to copy your bot token (keep this secret)
5. Go to "OAuth2" → "URL Generator"
6. Select scopes: `bot`
7. Select permissions: `Send Messages`, `Read Messages/View Channels`, `Read Message History`
8. Copy the generated URL and open it in your browser to invite the bot to your server

### 2. Get Your Application's Public Key

1. Go back to the "General Information" tab
2. Copy the "Public Key" value

### 3. Configure Rudy

1. Open Rudy Settings
2. Navigate to the Discord section
3. Enter the following:
   - **Public Key**: Paste the public key from step 2
   - **Bot Token**: Paste the bot token from step 1
   - **Channel ID** (optional): To restrict messages to a specific channel, enter its ID. Leave blank to accept from any channel.
   - **Port** (optional): The local port for the webhook server (default: 3848)

### 4. Set Up the Webhook

1. Click "Start" in the Discord settings
2. Rudy will generate a tunnel URL and show it
3. Copy this URL
4. Go back to Discord Developer Portal
5. Go to your application and click "Interactions Endpoint URL"
6. Paste the tunnel URL (with `/interactions` appended if needed)
7. Click "Save"
8. Discord will verify the endpoint by sending a PING interaction

### 5. Enable the Discord Bot

1. Go to your Discord server
2. Right-click on the channel where you want to enable Rudy
3. Click "Edit Channel" → Permissions
4. Add your Rudy bot to the channel with permissions:
   - Send Messages
   - View Channel
   - Read Message History

## Configuration Options

### Environment Variables

You can also configure Discord via environment variables in your `config.json`:

```json
{
  "discordEnabled": true,
  "discordPublicKey": "your-public-key-here",
  "discordBotToken": "your-bot-token-here",
  "discordChannelId": "channel-id-here",
  "discordPort": 3848,
  "discordProactivePosting": false
}
```

### Settings Parameters

- **discordEnabled**: Toggle Discord integration on/off
- **discordPublicKey**: Discord application public key (for signature verification)
- **discordBotToken**: Discord bot token (needed to reply to messages)
- **discordChannelId**: Restrict to a specific channel (optional)
- **discordPort**: Local HTTP server port (default: 3848)
- **discordProactivePosting**: Allow app-initiated messages to Discord (default: false)

## Usage

### Sending Messages

Simply post a message in the configured Discord channel and mention the bot or send it as a direct message:

```
@Rudy Execute a test and report results
```

Rudy will:
1. Receive the message
2. Create an autonomous worker
3. Execute the task
4. Reply in the same Discord thread/channel

### Autonomous Execution Protocol

When a message arrives via Discord:

1. **ROUTE FAST** — Rudy routes to the best agent immediately
2. **DELEGATE WITH REPLY HANDLE** — The agent is told to post its result back to Discord
3. **AUTONOMOUS EXECUTION** — No interactive questions, just do the work
4. **DIRECT REPLY** — Post substantive results (not just "done")
5. **REPORT** — Tell Rudy what was accomplished

### Message Format

Discord messages are treated as directives by default. To mark a message as communication only:

```
@Rudy [COMMUNICATION] What's the status of the build?
```

## Troubleshooting

### Webhook Not Connecting

- Check the public key matches your Discord application
- Verify the tunnel URL is accessible
- Check Discord bot permissions in the channel
- Look for errors in Rudy's logs

### Messages Not Being Received

- Ensure the bot is in the Discord channel
- Check that the channel ID (if specified) matches
- Verify the bot has Read Messages permission
- Check the trigger mode in Settings

### Replies Not Posting

- Verify the bot token is correct
- Ensure the bot has Send Messages permission
- Check that the channel exists and is accessible

## Security Considerations

1. **Bot Token**: Keep your bot token secret. Never commit it to version control.
2. **Public Key**: This is only used for signature verification and is not a secret.
3. **Signature Verification**: All Discord interactions are verified using Ed25519 signatures.
4. **Channel Restriction**: Use `discordChannelId` to limit Rudy to a specific channel.
5. **Proactive Posting**: Keep disabled unless you specifically want app-initiated Discord messages.

## Multiple Discord Servers

To connect Rudy to multiple Discord servers:

1. Create a separate Discord application for each server, or
2. Invite the same bot to multiple servers and configure different channels

Each server requires its own webhook setup with the appropriate URL.

## API Reference

### Incoming Message Format

```typescript
interface DiscordInboundMessage {
  author: string;           // Discord username
  text: string;             // Message content
  channel: string;          // Channel ID
  messageId: string;        // Message ID for threading
  interactionToken: string; // Token for responding
}
```

### Reply Format

To post a reply to Discord, use the helper script:

```bash
node rudy-discord-reply.cjs --channel <channelId> --message <messageId> --text "<your response>"
```

## Limitations

- Discord has a 3-second timeout for interaction responses, so Rudy must respond quickly
- Messages are currently limited to Discord's native text format
- File attachments are not yet supported in Discord ingestion
- Threads are tracked by message ID, not thread ID (Discord thread support may be added later)

## Future Enhancements

Planned features:

- [ ] Support for Discord slash commands
- [ ] Support for Discord modal interactions
- [ ] File attachment support
- [ ] Rich message formatting with embeds
- [ ] Thread reply support
- [ ] Reaction-based approvals (similar to iMessage tapbacks)
