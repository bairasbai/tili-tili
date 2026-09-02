import { t } from './i18n'
/* 10 сценариев приглашений — каждый со своим характером */
export interface InviteTheme {
  id: string
  name: string
  desc: string
  emoji: string
  opening: 'curtains' | 'doors' | 'lift' | 'fade'
  overlay: string          // фон стартового экрана
  overlayInk: string       // текст стартового экрана
  bg: string               // фон истории
  card: string             // карточки
  ink: string              // основной текст
  soft: string             // вторичный текст
  accent: string           // акцент (кнопки, детали)
  accentGrad: string       // градиент CTA
  serif: boolean           // серифы или гротеск
  deco: string[]           // парящие элементы параллакса
}

export const inviteThemes: InviteTheme[] = [
  {
    id: 'teatro', name: t('Театро'), desc: t('Бархатный занавес и премьера вашей истории'), emoji: '🎭',
    opening: 'curtains',
    overlay: 'repeating-linear-gradient(90deg,#8E3B3B 0 14px,#7C3232 14px 28px,#964242 28px 42px)',
    overlayInk: '#FFF7F0',
    bg: '#F6EDE7', card: '#FFFFFF', ink: '#3A2E28', soft: '#A98A80',
    accent: '#B57171', accentGrad: 'linear-gradient(120deg,#D9A8A0,#C98A8A 45%,#A9BCA0)',
    serif: true, deco: ['🎭', '🌹', '🕯'],
  },
  {
    id: 'bloom', name: 'Bloom', desc: t('Воздушные цветы и мягкая романтика'), emoji: '🌸',
    opening: 'fade',
    overlay: 'linear-gradient(160deg,#F2DFDC,#FBF6F1)',
    overlayInk: '#8E5A5A',
    bg: '#FBF3F1', card: '#FFFFFF', ink: '#43303A', soft: '#B08F97',
    accent: '#C98A8A', accentGrad: 'linear-gradient(120deg,#E5B8B4,#C98A8A)',
    serif: true, deco: ['🌸', '🌷', '🌺'],
  },
  {
    id: 'sage', name: t('Шалфей'), desc: t('Природная спокойная элегантность'), emoji: '🌿',
    opening: 'lift',
    overlay: 'linear-gradient(160deg,#7E9A74,#A9BCA0)',
    overlayInk: '#F4F8F0',
    bg: '#F2F6EE', card: '#FFFFFF', ink: '#2F3A2B', soft: '#8FA086',
    accent: '#7E9A74', accentGrad: 'linear-gradient(120deg,#A9BCA0,#7E9A74)',
    serif: true, deco: ['🌿', '🍃', '🕊'],
  },
  {
    id: 'editorial', name: 'Editorial', desc: t('Журнальная типографика, строгая композиция'), emoji: '◻️',
    opening: 'lift',
    overlay: 'linear-gradient(180deg,#1E1A16,#3A322B)',
    overlayInk: '#EFE9DF',
    bg: '#F7F5F1', card: '#FFFFFF', ink: '#1E1B16', soft: '#8A837A',
    accent: '#1E1B16', accentGrad: 'linear-gradient(120deg,#2E2A26,#5C554B)',
    serif: false, deco: ['◻️', '◼️', '—'],
  },
  {
    id: 'dolce', name: 'Dolce Vita', desc: t('Итальянское лето и кинематографичный свет'), emoji: '🍋',
    opening: 'fade',
    overlay: 'linear-gradient(160deg,#E3A86A,#C4705A)',
    overlayInk: '#FFF6EC',
    bg: '#FBF1E4', card: '#FFFFFF', ink: '#4A3423', soft: '#B08C66',
    accent: '#C4705A', accentGrad: 'linear-gradient(120deg,#E8B478,#C4705A)',
    serif: true, deco: ['🍋', '🫒', '🌻'],
  },
  {
    id: 'boho', name: 'Boho', desc: t('Тёплая богемная палитра и свободная композиция'), emoji: '🌾',
    opening: 'doors',
    overlay: 'linear-gradient(90deg,#B98A5A 0 50%,#A87A4C 50% 100%)',
    overlayInk: '#FBF1E2',
    bg: '#F7EEE1', card: '#FFFDF8', ink: '#4C3A28', soft: '#A98F72',
    accent: '#A87A4C', accentGrad: 'linear-gradient(120deg,#D9B98A,#A87A4C)',
    serif: true, deco: ['🌾', '🪶', '🌙'],
  },
  {
    id: 'garden', name: 'Secret Garden', desc: t('Таинственный сад и камерная романтика'), emoji: '🗝',
    opening: 'doors',
    overlay: 'linear-gradient(90deg,#2E4638 0 50%,#243A2D 50% 100%)',
    overlayInk: '#E6EEE2',
    bg: '#EEF3EA', card: '#FFFFFF', ink: '#24352A', soft: '#7E9284',
    accent: '#4A6B52', accentGrad: 'linear-gradient(120deg,#6E9478,#3E5C46)',
    serif: true, deco: ['🗝', '🌹', '🍄'],
  },
  {
    id: 'maestoso', name: t('Маджестик'), desc: t('Жемчуг, золото и вышивка ручной работы'), emoji: '👑',
    opening: 'curtains',
    overlay: 'repeating-linear-gradient(90deg,#2A3140 0 14px,#232B38 14px 28px,#313A4C 28px 42px)',
    overlayInk: '#F0DCB8',
    bg: '#F4F1EA', card: '#FFFFFF', ink: '#2A2E38', soft: '#9A9484',
    accent: '#B98A2F', accentGrad: 'linear-gradient(120deg,#E3C892,#B98A2F)',
    serif: true, deco: ['👑', '⚜️', '🕯'],
  },
  {
    id: 'minimal', name: 'Minimal Fun', desc: t('Современная типографика с лёгким характером'), emoji: '✌️',
    opening: 'lift',
    overlay: 'linear-gradient(160deg,#F0DCB8,#F7ECD9)',
    overlayInk: '#4A3A22',
    bg: '#FCFAF4', card: '#FFFFFF', ink: '#232018', soft: '#A09A8C',
    accent: '#D9A13B', accentGrad: 'linear-gradient(120deg,#E8BE6A,#D9A13B)',
    serif: false, deco: ['✌️', '⚡️', '💛'],
  },
  {
    id: 'nautical', name: 'Nautical', desc: t('Морская графика и свежий синий акцент'), emoji: '⚓️',
    opening: 'fade',
    overlay: 'linear-gradient(160deg,#5B7A99,#3E5872)',
    overlayInk: '#EDF3F8',
    bg: '#F0F4F8', card: '#FFFFFF', ink: '#22303E', soft: '#7E93A6',
    accent: '#4A6E94', accentGrad: 'linear-gradient(120deg,#7FA3C4,#4A6E94)',
    serif: false, deco: ['⚓️', '🌊', '🐚'],
  },
]
