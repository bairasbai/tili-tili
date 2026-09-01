import { useStore } from './store'

/* Минимальный i18n: ключ = русская строка. Полный словарь появится при выходе на EN-рынок. */
const EN: Record<string, string> = {
  'Главная': 'Home',
  'Поиск': 'Search',
  'Свадьба': 'Wedding',
  'Чаты': 'Chats',
  'Мы': 'Us',
  'Уведомления': 'Notifications',
  'Настройки': 'Settings',
  'Поддержка': 'Support',
  'Бюджет': 'Budget',
  'Чек-лист': 'Checklist',
  'Тайминг': 'Timeline',
  'Гости': 'Guests',
  'Документы': 'Documents',
  'Избранное': 'Favorites',
  'Заметки': 'Notes',
  'Рассадка': 'Seating',
  'Пригласить': 'Invite',
  'Сравнить': 'Compare',
  'Все специалисты': 'All vendors',
  'Назад': 'Back',
  'Далее': 'Next',
  'Готово': 'Done',
  'Сохранить': 'Save',
  'Отмена': 'Cancel',
  'Удалить': 'Delete',
}

export function t(s: string, lang: 'ru' | 'en'): string {
  return lang === 'en' ? (EN[s] ?? s) : s
}

export function useT() {
  const { lang } = useStore()
  return (s: string) => t(s, lang)
}
