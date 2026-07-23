---
'@opendj/frontend': minor
---

Add `AuthApi.requestPasswordReset(email)` and `AuthApi.resetPassword(token, newPassword)` for the email password-reset flow, and wire the template's login page (forgot-password mode) plus a new `/host/reset-password` page to them.
