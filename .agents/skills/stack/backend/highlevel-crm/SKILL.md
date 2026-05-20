---
name: highlevel-crm
description:
  Integrates with the HighLevel (GoHighLevel) CRM API v2 and its automation
  engine. Use when synchronizing data via OAuth 2.0, building custom widgets,
  handling sub-account `locationId` scoping, or implementing webhook-driven
  workflows with rate-limit-aware retries.
vendor: highlevel
---

# Skill: HighLevel CRM (GoHighLevel)

## Policy Capsule

- Integrate with HighLevel exclusively through API v2 over OAuth 2.0; never hardcode credentials.
- Manage `access_token` and `refresh_token` rotation in code — assume tokens expire and refresh proactively.
- Include `locationId` on every API request to scope writes to the correct sub-account.
- Prefer HighLevel's native automation engine; reach for custom code only when native workflows cannot express the requirement.
- Implement exponential-backoff retry to respect HighLevel's API rate limits.
- Use email as the primary key for contact deduplication; do not rely on CRM-internal IDs for cross-system joins.
- Drive event-driven flows through HighLevel webhooks rather than polling.
- Test integrations against a sandbox sub-account before pointing them at live data.

Protocols for integrating with the HighLevel CRM API (v2) and building custom
widgets/automations.

## 1. Core Principles

- **API-First Integration:** Use the HighLevel API v2 for all data
  synchronization, focusing on OAuth 2.0 security.
- **Workflow Automation:** Leverage HighLevel's internal automation engine
  effectively; only use custom code when native workflows are insufficient.
- **Data Integrity:** Ensure all custom fields, tags, and contacts are mapped
  accurately to prevent data corruption.

## 2. Technical Standards

- **OAuth 2.0:** Securely manage `access_token` and `refresh_token` flows. Never
  hardcode credentials.
- **Webhooks:** Use webhooks to trigger application logic when events occur in
  CRM (e.g., contact created, opportunity moved).
- **Rate Limiting:** Implement exponential backoff and retry logic to respect
  HighLevel's API rate limits.
- **Location Context:** Always include the `locationId` in your API requests to
  ensure data is scoped to the correct sub-account.

## 3. Best Practices

- **Custom Fields:** Use unique, descriptive names for custom fields and mapping
  keys to avoid collisions.
- **Contact Sync:** Use email addresses as the primary identifier for contact
  deduplication.
- **Testing:** Always use a sandbox/test sub-account in HighLevel before
  deploying integrations to live accounts.
