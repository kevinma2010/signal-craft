# Security Policy

## Supported Versions

During the MVP stage, only the current main branch and latest tagged release are supported.

## Reporting

Do not open public issues for vulnerabilities involving credentials, authentication, sensitive preferences, private feeds, delivery credentials, code execution, injection, or supply-chain risks.

Report them privately through GitHub's private vulnerability reporting: open the repository's **Security** tab and choose **Report a vulnerability**. Include the affected component, reproduction steps, impact, and suggested mitigation.

## Credential Handling

Store credentials locally when possible, never log secrets, use minimum scopes, and document every external service receiving user data.

## Untrusted Content

Fetched content is untrusted input. Defend against prompt injection, malicious HTML, script injection, unsafe downloads, URL spoofing, oversized payloads, and poisoned content.
