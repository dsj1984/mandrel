---
name: google-analytics-v4
description:
  Implements privacy-compliant event tracking with Google Analytics 4. Use
  when wiring analytics that must comply with GDPR/CCPA via Consent Mode V2 —
  `snake_case` event names, no PII to GA servers, GTM-driven event firing,
  and DebugView verification before deploy.
vendor: google
---

# Skill: Google Analytics 4 (GA4)

## Policy Capsule

- Implement Consent Mode V2 and respect GDPR/CCPA; never send PII to GA servers.
- Track meaningful business actions (e.g. `start_checkout`, `share_article`) rather than relying solely on page views.
- Use `snake_case` for every event name and parameter — GA4 enforces this convention.
- Fire all events through Google Tag Manager rather than embedding measurement IDs directly in application code.
- Define critical user attributes (e.g. `user_type`, `pricing_plan`) as custom dimensions on the GA4 property.
- Verify every new event in GA4 DebugView before deploying to production.
- Filter development and internal traffic out of the production GA4 property.
- Keep IP anonymization enabled and configure cross-domain tracking when traffic spans multiple origins.

Guidelines for privacy-compliant and data-driven event tracking using GA4.

## 1. Core Principles

- **Privacy Compliance:** Adhere to GDPR and CCPA. Implement Consent Mode V2 and
  never send PII to GA servers.
- **Event-Driven:** Focus on meaningful user actions (e.g., "start_checkout",
  "share_article") rather than just page views.
- **Data Accuracy:** Filter out development and internal traffic from production
  property data.

## 2. Technical Standards

- **GTM Integration:** Use Google Tag Manager for event firing to decouple
  marketing tags from core application code.
- **Custom Dimensions:** Define critical data points (e.g., `user_type`,
  `pricing_plan`) as custom dimensions in the GA4 property.
- **Enhanced Measurement:** Leverage GA4's built-in tracking for scrolls,
  outbound clicks, and site searches.

## 3. Best Practices

- **Naming Convention:** Use `snake_case` for event names and parameters.
- **Debug View:** Use the GA4 DebugView in the browser to verify events fire
  correctly before deploying.
- **Anonymization:** Ensure IP anonymization is enabled (default in GA4) and
  cross-domain tracking is configured if necessary.
