# Privacy Policy

Last updated: March 6, 2026

## Overview

Clawdex Mobile is a companion app for connecting to a bridge service that you run on your own machine. The app is designed for trusted private networking, such as LAN, VPN, or Tailscale. It is not a public multi-tenant shell service.

## Information Processed

Clawdex Mobile can process:

- Chat prompts and assistant responses
- Bridge connection details you enter in the app
- Terminal command text and command output returned by your bridge
- Git repository status, diffs, commit messages, and related metadata
- File or image attachments you choose to send
- Voice input audio used for speech-to-text features

## How Information Is Used

The app uses this information to:

- connect your phone to your self-hosted bridge
- display and continue assistant threads
- execute approved terminal and Git workflows on infrastructure you control
- upload user-selected files and images to your own workflow
- support optional voice-to-text input

## Storage and Retention

Clawdex Mobile does not define a separate cloud retention layer for your project data. Data is generally stored by services and infrastructure you control, including your local bridge, repository, logs, caches, and any model providers or integrations that you configure.

## Sharing

Clawdex Mobile does not include advertising SDKs. Data may be transmitted to third-party model or infrastructure providers only when you configure and use those services as part of your own setup.

## Security

Security depends on how you configure your bridge and network. The app is intended for trusted-network use. You are responsible for protecting bridge tokens, provider credentials, repository access, and device access.

## Your Responsibility

You are responsible for:

- operating the bridge only on systems you own or are authorized to control
- securing your network path and credentials
- reviewing commands, approvals, and repository actions before execution

## Contact

For support, use the project support channel:

https://github.com/Mohit-Patil/clawdex-mobile/issues
