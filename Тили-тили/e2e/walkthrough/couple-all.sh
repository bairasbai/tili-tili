#!/usr/bin/env bash
# Полный обход пары по чанкам (390px). Первый чанк — setup, дальше state-файл роли.
S="$(cd "$(dirname "$0")" && pwd)"
C="${LIVE_DIR:?LIVE_DIR не задан — см. README.md}/crawl"
mkdir -p "$C"
mkdir "$C/couple-all.lock" 2>/dev/null || { echo "lock held — second run skipped"; exit 0; }
R="$S/run.sh"
bash "$R" couple-2 couple 1 1 /home /search /search/photo /search/florist /vendor/{vendorId} /vendor/{floristVendorId} /compare /favorites
bash "$R" couple-3 couple 0 1 /notes /tools/alcohol /wedding /wedding/slot/{photoSlotId} /wedding/slot/{emptySlotId} /wedding/budget /wedding/checklist
bash "$R" couple-4 couple 0 1 /wedding/timeline /wedding/guests /wedding/seating /wedding/wishlist /wedding/logistics /wedding/catering
bash "$R" couple-5 couple 0 1 /wedding/planb /wedding/album /gifts /wedding/invites /wedding/documents /wedding/documents/new /deal/{dealId}
bash "$R" couple-6 couple 0 1 /assistant /dayx /after /us /us/team /inspiration /venues /us/chats /us/chats/{chatId} /support /legal/offer /legal/privacy
rmdir "$C/couple-all.lock"
echo "couple-all done"
