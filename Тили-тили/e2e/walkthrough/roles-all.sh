#!/usr/bin/env bash
# Обход остальных ролей (390px): помощник, координатор, подрядчик, флорист, сотрудник, гость.
S="$(cd "$(dirname "$0")" && pwd)"
C="${LIVE_DIR:?LIVE_DIR не задан — см. README.md}/crawl"
mkdir -p "$C"
mkdir "$C/roles-all.lock" 2>/dev/null || { echo "lock held — second run skipped"; exit 0; }
R="$S/run.sh"
W="/home /wedding /wedding/slot/{photoSlotId} /wedding/budget /wedding/checklist /wedding/timeline /wedding/guests /wedding/seating /wedding/wishlist /wedding/logistics /wedding/catering /wedding/planb /wedding/album /wedding/invites /wedding/documents /deal/{dealId} /dayx /after /us /us/team /us/chats /notes /favorites /search/photo /vendor/{vendorId} /settings"
bash "$R" helper-1 helper 1 1 $W
bash "$R" coord-1 coordinator 1 1 $W
bash "$R" vendor-1 vendor 1 1 /vendor-app /vendor-app/profile /vendor-app/deals /vendor-app/deals/{dealId} /vendor-app/verification /vendor-app/leads/{vendorLeadId} /vendor-app/reviews /vendor-app/analytics /vendor-app/chats /vendor-app/chats/{chatId} /vendor-app/settings /home /settings
bash "$R" florist-1 florist 1 1 /vendor-app /vendor-app/leads/{floristLeadId} /vendor-app/chats/{floristChatId} /vendor-app/deals
bash "$R" staff-1 staff 1 1 "block=одобрить|отклонить|верифиц|заблокир|предупредить|понизить|снять|взять в работу|выполнен|закрыть|отменить|удалить|выйти|отозвать|^english$|^русский$|^завершить$" /admin /admin/moderation /admin/moderation/{moderationVendorId} /admin/verifications /admin/verifications/{adminVerificationId} /admin/complaints /admin/concierge /admin/categories /admin/wedding
bash "$R" guest-1 guest 1 1 /invite /invite/day-chat /gifts /i/{guestCode}
rmdir "$C/roles-all.lock"
echo "roles-all done"
