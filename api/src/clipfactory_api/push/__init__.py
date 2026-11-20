"""Notifications on the owner's phone and computer (docs/CONTRACTS.md §32): Web Push to the installed web app.

``webpush`` signs (VAPID) and encrypts (aes128gcm) one message; ``devices`` keeps the owner's subscriptions;
``notify`` is ``cf-prod-notify``, which reads job changes from the table's stream and sends the notifications.
"""
