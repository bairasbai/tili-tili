import { Navigate, Route, Routes, useLocation } from 'react-router'
import { StoreProvider, useStore } from '@/lib/store'
import { ErrorBoundary } from '@/components/ErrorBoundary'
import { TabBar } from '@/components/chrome'
import Onboarding from '@/pages/Onboarding'
import Quiz from '@/pages/Quiz'
import Home from '@/pages/Home'
import { SearchCategories, VendorList, VendorDetail } from '@/pages/Search'
import { WeddingTeam, SlotDetail, Budget, Checklist, Timeline, Guests, Documents } from '@/pages/Wedding'
import { Us, Chats, Chat } from '@/pages/Us'
import Invite from '@/pages/Invite'
import { Auth, Notifications, Settings, Support } from '@/pages/Account'
import { Deal, ContractWizard, Seating, InviteEditor } from '@/pages/Tools'
import { Assistant, Compare, DayX, After } from '@/pages/Smart'
import { VendorDashboard, VendorProfileWizard, VendorDeals } from '@/pages/VendorApp'
import { VendorLead, VendorReviews, VendorAnalytics } from '@/pages/VendorExtras'
import { Team, Join } from '@/pages/Team'
import { Inspiration, VenuesMap } from '@/pages/Discover'
import { Favorites, Notes, AlcoholCalc } from '@/pages/Extras'

function Shell() {
  const { onboarded } = useStore()
  const loc = useLocation()
  const p = loc.pathname
  const noTab =
    ['/', '/quiz', '/invite', '/auth', '/dayx', '/assistant'].includes(p) ||
    p.startsWith('/join') ||
    p.startsWith('/us/chats/') ||
    p.startsWith('/vendor-app')
  return (
    <div className="app-shell">
      <Routes>
        <Route path="/" element={<Onboarding />} />
        <Route path="/quiz" element={<Quiz />} />
        <Route path="/invite" element={<Invite />} />
        <Route path="/auth" element={<Auth />} />
        <Route path="/join/:code" element={<Join />} />
        <Route path="/home" element={onboarded ? <Home /> : <Navigate to="/" replace />} />
        <Route path="/notifications" element={<Notifications />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="/support" element={<Support />} />
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
        <Route path="/wedding/invites" element={<InviteEditor />} />
        <Route path="/wedding/documents" element={<Documents />} />
        <Route path="/wedding/documents/new" element={<ContractWizard />} />
        <Route path="/deal" element={<Deal />} />
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
