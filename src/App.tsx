import { Navigate, Route, Routes, useLocation } from 'react-router'
import { StoreProvider, useStore } from '@/lib/store'
import { TabBar } from '@/components/chrome'
import Onboarding from '@/pages/Onboarding'
import Quiz from '@/pages/Quiz'
import Home from '@/pages/Home'
import { SearchCategories, VendorList, VendorDetail } from '@/pages/Search'
import { WeddingTeam, SlotDetail, Budget, Checklist, Timeline, Guests, Documents } from '@/pages/Wedding'
import { Us, Chats, Chat } from '@/pages/Us'
import Invite from '@/pages/Invite'

function Shell() {
  const { onboarded } = useStore()
  const loc = useLocation()
  const noTab = ['/', '/quiz', '/invite'].includes(loc.pathname) || loc.pathname.startsWith('/us/chats/')
  return (
    <div className="app-shell">
      <Routes>
        <Route path="/" element={<Onboarding />} />
        <Route path="/quiz" element={<Quiz />} />
        <Route path="/invite" element={<Invite />} />
        <Route path="/home" element={onboarded ? <Home /> : <Navigate to="/" replace />} />
        <Route path="/search" element={<SearchCategories />} />
        <Route path="/search/:catId" element={<VendorList />} />
        <Route path="/vendor/:id" element={<VendorDetail />} />
        <Route path="/wedding" element={<WeddingTeam />} />
        <Route path="/wedding/slot/:id" element={<SlotDetail />} />
        <Route path="/wedding/budget" element={<Budget />} />
        <Route path="/wedding/checklist" element={<Checklist />} />
        <Route path="/wedding/timeline" element={<Timeline />} />
        <Route path="/wedding/guests" element={<Guests />} />
        <Route path="/wedding/documents" element={<Documents />} />
        <Route path="/us" element={<Us />} />
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
    <StoreProvider>
      <Shell />
    </StoreProvider>
  )
}
