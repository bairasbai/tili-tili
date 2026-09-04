import { Suspense, lazy, useEffect } from 'react'
import { Navigate, Route, Routes, useLocation } from 'react-router'
import { StoreProvider, useStore } from '@/lib/store'
import { ErrorBoundary } from '@/components/ErrorBoundary'
import { TabBar, OfflineBanner } from '@/components/chrome'
import { t } from '@/lib/i18n'
import Onboarding from '@/pages/Onboarding'
import Quiz from '@/pages/Quiz'
import Home from '@/pages/Home'
import { Auth, Notifications, Settings, Support } from '@/pages/Account'

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
}

const SearchCategories = lazy(() => load.search().then(m => ({ default: m.SearchCategories })))
const VendorList = lazy(() => load.search().then(m => ({ default: m.VendorList })))
const VendorDetail = lazy(() => load.search().then(m => ({ default: m.VendorDetail })))

const WeddingTeam = lazy(() => load.wedding().then(m => ({ default: m.WeddingTeam })))
const SlotDetail = lazy(() => load.wedding().then(m => ({ default: m.SlotDetail })))
const Budget = lazy(() => load.wedding().then(m => ({ default: m.Budget })))
const Checklist = lazy(() => load.wedding().then(m => ({ default: m.Checklist })))
const Timeline = lazy(() => load.wedding().then(m => ({ default: m.Timeline })))
const Guests = lazy(() => load.wedding().then(m => ({ default: m.Guests })))
const Documents = lazy(() => load.wedding().then(m => ({ default: m.Documents })))
const Album = lazy(() => load.wedding().then(m => ({ default: m.Album })))

const Us = lazy(() => load.us().then(m => ({ default: m.Us })))
const Chats = lazy(() => load.us().then(m => ({ default: m.Chats })))
const Chat = lazy(() => load.us().then(m => ({ default: m.Chat })))

const Invite = lazy(() => load.invite())
const InviteRedeem = lazy(() => import('@/pages/InviteRedeem'))

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
const VendorProfileWizard = lazy(() => load.vendorApp().then(m => ({ default: m.VendorProfileWizard })))
const VendorDeals = lazy(() => load.vendorApp().then(m => ({ default: m.VendorDeals })))
const VendorLead = lazy(() => load.vendorExtras().then(m => ({ default: m.VendorLead })))
const VendorReviews = lazy(() => load.vendorExtras().then(m => ({ default: m.VendorReviews })))
const VendorAnalytics = lazy(() => load.vendorExtras().then(m => ({ default: m.VendorAnalytics })))

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

/* Заглушка на время загрузки чанка. Нарочно пустая: мигать скелетоном на
   переходе, который занимает десятки миллисекунд, хуже, чем не мигать. */
function RouteLoading() {
  return <div data-testid="route-loading" className="min-h-dvh" aria-busy="true" aria-label={t('Загрузка')} />
}

function Shell() {
  const { onboarded, theme, lang } = useStore()
  const loc = useLocation()
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
  const noTab =
    ['/', '/quiz', '/invite', '/auth', '/dayx', '/assistant', '/gifts'].includes(p) ||
    p.startsWith('/i/') ||
    p.startsWith('/join') ||
    p.startsWith('/us/chats/') ||
    p.startsWith('/vendor-app')
  return (
    <div className={`app-shell${noTab ? ' no-tab' : ''}`} key={lang}>
      <OfflineBanner />
      <Suspense fallback={<RouteLoading />}>
        <Routes>
          <Route path="/" element={<Onboarding />} />
          <Route path="/quiz" element={<Quiz />} />
          <Route path="/invite" element={<Invite />} />
          {/* Ссылка из приглашения ведёт сюда: код меняется на токен гостя и
              гаснет, дальше гость живёт на /invite. */}
          <Route path="/i/:code" element={<InviteRedeem />} />
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
          <Route path="/wedding/checklist" element={<Checklist />} />
          <Route path="/wedding/timeline" element={<Timeline />} />
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
          <Route path="/vendor-app/profile" element={<VendorProfileWizard />} />
          <Route path="/vendor-app/deals" element={<VendorDeals />} />
          <Route path="/vendor-app/leads/:id" element={<VendorLead />} />
          <Route path="/vendor-app/reviews" element={<VendorReviews />} />
          <Route path="/vendor-app/analytics" element={<VendorAnalytics />} />
          <Route path="/us" element={<Us />} />
          <Route path="/us/team" element={<Team />} />
          <Route path="/inspiration" element={<Inspiration />} />
          <Route path="/venues" element={<VenuesMap />} />
          <Route path="/us/chats" element={<Chats />} />
          <Route path="/us/chats/:id" element={<Chat />} />
          <Route path="*" element={<Navigate to={onboarded ? '/home' : '/'} replace />} />
        </Routes>
      </Suspense>
      {!noTab && <TabBar />}
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
