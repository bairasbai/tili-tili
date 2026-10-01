import { Suspense, lazy, useEffect, useReducer } from 'react'
import { Navigate, Route, Routes, useLocation } from 'react-router'
import { StoreProvider, useStore } from '@/lib/store'
import { ErrorBoundary } from '@/components/ErrorBoundary'
import { TabBar, VendorTabBar, OfflineBanner } from '@/components/chrome'
import { AppUpdate } from '@/components/AppUpdate'
import { t } from '@/lib/i18n'
import { CONSENT_OUTDATED_KEY, consentOutdated, isAuthorized, onConsentOutdated } from '@/lib/api/client'
import Onboarding from '@/pages/Onboarding'
import Quiz from '@/pages/Quiz'
import Home from '@/pages/Home'
import { Auth, Notifications, Settings, Support } from '@/pages/Account'
/* Не `lazy`: гейт обязан быть в первом кадре и офлайн, а ленивый чанк может
   не лежать в кэше service worker'а до первого онлайн-визита (F4, RL-1). */
import { ConsentGate } from '@/pages/Consent'

/*
 * Разделение бандла. Сразу грузится только путь первого запуска — онбординг,
 * квиз, вход и главная. Остальные экраны приезжают своим чанком по мере
 * перехода: гостю, открывшему приглашение, незачем качать кабинет подрядчика,
 * вишлист и логистику.
 *
 * Каждый файл страниц экспортирует несколько экранов, поэтому import() указывает
 * на модуль целиком — один чанк на файл, повторные переходы уже без загрузки.
 */
const load = {
  search: () => import('@/pages/Search'),
  wedding: () => import('@/pages/Wedding'),
  us: () => import('@/pages/Us'),
  invite: () => import('@/pages/Invite'),
  tools: () => import('@/pages/Tools'),
  smart: () => import('@/pages/Smart'),
  vendorApp: () => import('@/pages/VendorApp'),
  vendorExtras: () => import('@/pages/VendorExtras'),
  team: () => import('@/pages/Team'),
  discover: () => import('@/pages/Discover'),
  extras: () => import('@/pages/Extras'),
  legal: () => import('@/pages/Legal'),
  wishlist: () => import('@/pages/Wishlist'),
  logistics: () => import('@/pages/Logistics'),
  admin: () => import('@/pages/Admin'),
}

const SearchCategories = lazy(() => load.search().then(m => ({ default: m.SearchCategories })))
const VendorList = lazy(() => load.search().then(m => ({ default: m.VendorList })))
const VendorDetail = lazy(() => load.search().then(m => ({ default: m.VendorDetail })))

const WeddingTeam = lazy(() => load.wedding().then(m => ({ default: m.WeddingTeam })))
const SlotDetail = lazy(() => load.wedding().then(m => ({ default: m.SlotDetail })))
const PaymentSchedule = lazy(() => import('./pages/PaymentSchedule'))
const Budget = lazy(() => load.wedding().then(m => ({ default: m.Budget })))
const Checklist = lazy(() => load.wedding().then(m => ({ default: m.Checklist })))
const Timeline = lazy(() => load.wedding().then(m => ({ default: m.Timeline })))
const WeddingEvents = lazy(() => import('@/pages/WeddingEvents'))
const EventInvitations = lazy(() => import('@/pages/EventInvitations'))
const Guests = lazy(() => load.wedding().then(m => ({ default: m.Guests })))
const Documents = lazy(() => load.wedding().then(m => ({ default: m.Documents })))
const Album = lazy(() => load.wedding().then(m => ({ default: m.Album })))

const Us = lazy(() => load.us().then(m => ({ default: m.Us })))
const Chats = lazy(() => load.us().then(m => ({ default: m.Chats })))
const Chat = lazy(() => load.us().then(m => ({ default: m.Chat })))

const Invite = lazy(() => load.invite())
/* Чат дня гостя живёт в том же чанке, что приглашение: гость приходит туда с `/invite`. */
const GuestDayChat = lazy(() => load.invite().then(m => ({ default: m.GuestDayChat })))
const InviteRedeem = lazy(() => import('@/pages/InviteRedeem'))
/* Свой чанк, как у InviteRedeem: гость-подрядчик приходит по ссылке из вне,
   догружать чужие бандлы (кабинет пары, каталог) ему незачем (SB-01, ERR-0272). */
const GuestVendor = lazy(() => import('@/pages/GuestVendor'))

const Deal = lazy(() => load.tools().then(m => ({ default: m.Deal })))
const ContractWizard = lazy(() => load.tools().then(m => ({ default: m.ContractWizard })))
const Seating = lazy(() => load.tools().then(m => ({ default: m.Seating })))
const InviteEditor = lazy(() => load.tools().then(m => ({ default: m.InviteEditor })))

const Assistant = lazy(() => load.smart().then(m => ({ default: m.Assistant })))
const Compare = lazy(() => load.smart().then(m => ({ default: m.Compare })))
const DayX = lazy(() => load.smart().then(m => ({ default: m.DayX })))
const After = lazy(() => load.smart().then(m => ({ default: m.After })))
const PlanB = lazy(() => load.smart().then(m => ({ default: m.PlanB })))

const VendorDashboard = lazy(() => load.vendorApp().then(m => ({ default: m.VendorDashboard })))
const VendorPrograms = lazy(() => import('@/pages/VendorPrograms').then(m => ({ default: m.VendorPrograms })))
const VendorProgramReader = lazy(() => import('@/pages/VendorPrograms').then(m => ({ default: m.VendorProgramReader })))
const VendorProfileWizard = lazy(() => load.vendorApp().then(m => ({ default: m.VendorProfileWizard })))
const VendorDeals = lazy(() => load.vendorApp().then(m => ({ default: m.VendorDeals })))
const VendorVerification = lazy(() => load.vendorApp().then(m => ({ default: m.VendorVerification })))
const VendorLead = lazy(() => load.vendorExtras().then(m => ({ default: m.VendorLead })))
const VendorDealCard = lazy(() => load.vendorExtras().then(m => ({ default: m.VendorDealCard })))
const VendorReviews = lazy(() => load.vendorExtras().then(m => ({ default: m.VendorReviews })))
const VendorAnalytics = lazy(() => load.vendorExtras().then(m => ({ default: m.VendorAnalytics })))
const VendorOfferRequests = lazy(() => load.vendorExtras().then(m => ({ default: m.VendorOfferRequests })))

const Offer = lazy(() => load.legal().then(m => ({ default: m.Offer })))
const Privacy = lazy(() => load.legal().then(m => ({ default: m.Privacy })))

const Team = lazy(() => load.team().then(m => ({ default: m.Team })))
const Join = lazy(() => load.team().then(m => ({ default: m.Join })))

const Inspiration = lazy(() => load.discover().then(m => ({ default: m.Inspiration })))
const VenuesMap = lazy(() => load.discover().then(m => ({ default: m.VenuesMap })))

const Favorites = lazy(() => load.extras().then(m => ({ default: m.Favorites })))
const Notes = lazy(() => load.extras().then(m => ({ default: m.Notes })))
const AlcoholCalc = lazy(() => load.extras().then(m => ({ default: m.AlcoholCalc })))

const WishlistManage = lazy(() => load.wishlist().then(m => ({ default: m.WishlistManage })))
const GiftPick = lazy(() => load.wishlist().then(m => ({ default: m.GiftPick })))

const Logistics = lazy(() => load.logistics().then(m => ({ default: m.Logistics })))
const Catering = lazy(() => load.logistics().then(m => ({ default: m.Catering })))

/* Панель платформы — один чанк на весь раздел: сотрудников единицы, и качать
   его паре, которая туда никогда не зайдёт, незачем. */
const AdminHome = lazy(() => load.admin().then(m => ({ default: m.AdminHome })))
const AdminModeration = lazy(() => load.admin().then(m => ({ default: m.AdminModeration })))
const AdminVendorDecision = lazy(() => load.admin().then(m => ({ default: m.AdminVendorDecision })))
const AdminVerifications = lazy(() => load.admin().then(m => ({ default: m.AdminVerifications })))
const AdminVerification = lazy(() => load.admin().then(m => ({ default: m.AdminVerification })))
const AdminComplaints = lazy(() => load.admin().then(m => ({ default: m.AdminComplaints })))
const AdminConcierge = lazy(() => load.admin().then(m => ({ default: m.AdminConcierge })))
const AdminCategories = lazy(() => load.admin().then(m => ({ default: m.AdminCategories })))
const AdminWedding = lazy(() => load.admin().then(m => ({ default: m.AdminWedding })))

/* Заглушка на время загрузки чанка. Нарочно пустая: мигать скелетоном на
   переходе, который занимает десятки миллисекунд, хуже, чем не мигать. */
function RouteLoading() {
  return <div data-testid="route-loading" className="min-h-dvh" aria-busy="true" aria-label={t('Загрузка')} />
}

/**
 * Пути, свободные от гейта устаревшего согласия (F4, RL-1): документы (их
 * можно читать с гейта — «Назад» там возвращает на него же, `chrome.tsx`) и
 * гостевые адреса по токену — другая личность, сервер согласия там не
 * проверяет (та же граница, что у `noTab` ниже).
 */
function consentGateFree(p: string): boolean {
  return (
    p === '/legal/offer' ||
    p === '/legal/privacy' ||
    p === '/invite' ||
    p.startsWith('/invite/') ||
    p.startsWith('/i/') ||
    p.startsWith('/guest-vendor/') ||
    p === '/gifts'
  )
}

function Shell() {
  const { onboarded, theme, lang } = useStore()
  const loc = useLocation()
  /*
   * Гейт устаревшего согласия (F4, RL-1): нет своего состояния — только
   * принудительный перерендер. `bump` меняется, `consentOutdated()` читает
   * `localStorage` заново на каждой отрисовке, поэтому отдельного `useState`
   * с флагом не нужно (и не разойдётся с хранилищем).
   */
  const [, bump] = useReducer((n: number) => n + 1, 0)
  useEffect(() => onConsentOutdated(bump), [])
  /* Вторая вкладка приняла или вышла: `storage` — событие только чужих
     документов того же источника (см. тот же приём в `store.tsx`, подписка на `storage`). */
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === CONSENT_OUTDATED_KEY || e.key === null) bump()
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])
  useEffect(() => {
    document.documentElement.dataset.theme = theme
    // строка статуса телефона должна совпадать с фоном приложения, иначе в тёмной
    // теме сверху остаётся кремовая полоса
    document.querySelector('meta[name="theme-color"]')
      ?.setAttribute('content', theme === 'dark' ? '#1E1A16' : '#FBF6F1')
  }, [theme])
  useEffect(() => {
    document.documentElement.lang = lang
    // заголовок вкладки и описание живут в <head>, вне React-дерева: без этого
    // при EN интерфейс переведён, а вкладка и превью ссылки остаются русскими
    document.title = t('Тили-тили — свадьба в одном приложении')
    document.querySelector('meta[name="description"]')
      ?.setAttribute('content', t('Тили-тили — вся свадьба в одном приложении'))
  }, [lang])
  // новый экран — всегда с верха страницы (иначе на телефоне кажется, что «ничего не нажалось»)
  useEffect(() => { window.scrollTo(0, 0) }, [loc.pathname])
  const p = loc.pathname
  /* Гейт держит вошедшего с устаревшей подписью на любом несвободном пути —
     гостевые токены и документы не трогает (F4, RL-1). */
  const gated = consentOutdated() && isAuthorized() && !consentGateFree(p)
  /* Кабинет подрядчика — со своей навигацией (фича 007): на всех `/vendor-app*`,
     кроме переписки, где низ занимает поле ввода — как у пары в `/us/chats/:id`. */
  const vendorTab = p.startsWith('/vendor-app') && !p.startsWith('/vendor-app/chats/')
  const noTab =
    gated ||
    ['/', '/quiz', '/invite', '/auth', '/dayx', '/assistant', '/gifts'].includes(p) ||
    /* Гость без аккаунта: нижняя навигация пары ему ни к чему и на чате дня. */
    p.startsWith('/invite/') ||
    p.startsWith('/i/') ||
    p.startsWith('/join') ||
    /* Гость-подрядчик: тот же класс, что гость дня X — своего аккаунта и
       нижней навигации пары у него нет (SB-01, ERR-0272). */
    p.startsWith('/guest-vendor/') ||
    p.startsWith('/us/chats/') ||
    (p.startsWith('/vendor-app') && !vendorTab) ||
    /* Панель платформы — не раздел пары: нижняя навигация здесь предлагала бы
       уйти в «Свадьбу» и «Чаты» посреди разбора чужой жалобы. */
    p.startsWith('/admin')
  return (
    <div className={`app-shell${noTab ? ' no-tab' : ''}`} key={lang}>
      <OfflineBanner />
      <AppUpdate />
      {gated ? <ConsentGate onDone={bump} /> : (
      <Suspense fallback={<RouteLoading />}>
        <Routes>
          <Route path="/" element={<Onboarding />} />
          <Route path="/quiz" element={<Quiz />} />
          <Route path="/invite" element={<Invite />} />
          {/* Чат дня X глазами гостя (фича 009): вход — из раздела «День
              свадьбы» на /invite, «Назад» возвращает туда же. */}
          <Route path="/invite/day-chat" element={<GuestDayChat />} />
          {/* Ссылка из приглашения ведёт сюда: код меняется на токен гостя и
              гаснет, дальше гость живёт на /invite. */}
          <Route path="/i/:code" element={<InviteRedeem />} />
          {/* Свой подрядчик слота по ссылке пары — без аккаунта, только токен
              в URL (SB-01, ERR-0272): видит дату, тайминг дня и чат с парой. */}
          <Route path="/guest-vendor/:token" element={<GuestVendor />} />
          <Route path="/auth" element={<Auth />} />
          <Route path="/join/:code" element={<Join />} />
          <Route path="/home" element={onboarded ? <Home /> : <Navigate to="/" replace />} />
          <Route path="/notifications" element={<Notifications />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="/support" element={<Support />} />
          <Route path="/legal/offer" element={<Offer />} />
          <Route path="/legal/privacy" element={<Privacy />} />
          <Route path="/search" element={<SearchCategories />} />
          <Route path="/search/:catId" element={<VendorList />} />
          <Route path="/vendor/:id" element={<VendorDetail />} />
          <Route path="/compare" element={<Compare />} />
          <Route path="/favorites" element={<Favorites />} />
          <Route path="/notes" element={<Notes />} />
          <Route path="/tools/alcohol" element={<AlcoholCalc />} />
          <Route path="/wedding" element={<WeddingTeam />} />
          <Route path="/wedding/slot/:id" element={<SlotDetail />} />
          <Route path="/wedding/budget" element={<Budget />} />
              <Route path="/wedding/payments" element={<PaymentSchedule />} />
          <Route path="/wedding/checklist" element={<Checklist />} />
          <Route path="/wedding/timeline" element={<Timeline />} />
          <Route path="/wedding/events" element={<WeddingEvents />} />
          <Route path="/wedding/events/:eventId/invitations" element={<EventInvitations />} />
          <Route path="/wedding/guests" element={<Guests />} />
          <Route path="/wedding/seating" element={<Seating />} />
          <Route path="/wedding/wishlist" element={<WishlistManage />} />
          <Route path="/wedding/logistics" element={<Logistics />} />
          <Route path="/wedding/catering" element={<Catering />} />
          <Route path="/wedding/planb" element={<PlanB />} />
          <Route path="/wedding/album" element={<Album />} />
          <Route path="/gifts" element={<GiftPick />} />
          <Route path="/wedding/invites" element={<InviteEditor />} />
          <Route path="/wedding/documents" element={<Documents />} />
          <Route path="/wedding/documents/new" element={<ContractWizard />} />
          <Route path="/deal/:id" element={<Deal />} />
          <Route path="/assistant" element={<Assistant />} />
          <Route path="/dayx" element={<DayX />} />
          <Route path="/after" element={<After />} />
          <Route path="/vendor-app" element={<VendorDashboard />} />
          <Route path="/vendor-app/programs" element={<VendorPrograms />} />
          <Route path="/vendor-app/programs/:weddingId" element={<VendorProgramReader />} />
          <Route path="/vendor-app/profile" element={<VendorProfileWizard />} />
          <Route path="/vendor-app/deals" element={<VendorDeals />} />
          <Route path="/vendor-app/deals/:id" element={<VendorDealCard />} />
          <Route path="/vendor-app/verification" element={<VendorVerification />} />
          <Route path="/vendor-app/leads/:id" element={<VendorLead />} />
          <Route path="/vendor-app/reviews" element={<VendorReviews />} />
          <Route path="/vendor-app/analytics" element={<VendorAnalytics />} />
          <Route path="/vendor-app/offer-requests" element={<VendorOfferRequests />} />
          {/* Чаты и настройки кабинета — те же экраны, что у пары, в режиме
              кабинета (фича 007): данные и права у них общие, разные только
              слова и адреса возврата. */}
          <Route path="/vendor-app/chats" element={<Chats home="/vendor-app" />} />
          <Route path="/vendor-app/chats/:id" element={<Chat home="/vendor-app" />} />
          <Route path="/vendor-app/settings" element={<Settings vendor />} />
          {/* Двойник уведомлений в кабинете (F-RL-8-10): страница та же, но
              обрамление выбирается по пути, и подрядчик на `/notifications`
              получал нижнюю навигацию ПАРЫ: «Свадьба» вела в состояние без
              свадьбы, «Чаты» — в чужие чаты пары. Тот же приём, что у
              `/vendor-app/chats` и `/vendor-app/settings`. */}
          <Route path="/vendor-app/notifications" element={<Notifications />} />
          <Route path="/us" element={<Us />} />
          <Route path="/us/team" element={<Team />} />
          <Route path="/inspiration" element={<Inspiration />} />
          <Route path="/venues" element={<VenuesMap />} />
          <Route path="/us/chats" element={<Chats />} />
          <Route path="/us/chats/:id" element={<Chat />} />
          <Route path="/admin" element={<AdminHome />} />
          <Route path="/admin/moderation" element={<AdminModeration />} />
          <Route path="/admin/moderation/:vendorId" element={<AdminVendorDecision />} />
          <Route path="/admin/verifications" element={<AdminVerifications />} />
          <Route path="/admin/verifications/:requestId" element={<AdminVerification />} />
          <Route path="/admin/complaints" element={<AdminComplaints />} />
          <Route path="/admin/concierge" element={<AdminConcierge />} />
          <Route path="/admin/categories" element={<AdminCategories />} />
          <Route path="/admin/wedding" element={<AdminWedding />} />
          <Route path="*" element={<Navigate to={onboarded ? '/home' : '/'} replace />} />
        </Routes>
      </Suspense>
      )}
      {!noTab && (vendorTab ? <VendorTabBar /> : <TabBar />)}
    </div>
  )
}

export default function App() {
  return (
    <ErrorBoundary>
      <StoreProvider>
        <Shell />
      </StoreProvider>
    </ErrorBoundary>
  )
}
