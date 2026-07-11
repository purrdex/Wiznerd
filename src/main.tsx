import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { createBrowserRouter, RouterProvider } from 'react-router-dom'
import './index.css'
import WalletApp from './wallet/App'
import CreateScreen from './create'
import MarketplaceScreen from './marketplace'
import CollectionScreen from './marketplace/Collection'
import ManageScreen from './marketplace/Manage'
import ProfileScreen from './marketplace/Profile'
import OffersScreen from './marketplace/Offers'
import RankingsScreen from './marketplace/Rankings'
import ActivityScreen from './marketplace/Activity'
import CreatorScreen from './marketplace/Creator'
import WatchlistScreen from './marketplace/Watchlist'
import UserProfileScreen from './marketplace/UserProfile'
import TokensScreen from './marketplace/Tokens'
import TokenDetailScreen from './marketplace/TokenDetail'
import { CartProvider } from './marketplace/CartContext'
import { ToastProvider } from './components/ToastContext'

const router = createBrowserRouter([
  { path: '/', element: <WalletApp /> },
  { path: '/create', element: <CreateScreen /> },
  { path: '/marketplace', element: <MarketplaceScreen /> },
  { path: '/marketplace/offers', element: <OffersScreen /> },
  { path: '/marketplace/rankings', element: <RankingsScreen /> },
  { path: '/marketplace/activity', element: <ActivityScreen /> },
  { path: '/marketplace/watchlist', element: <WatchlistScreen /> },
  { path: '/marketplace/profile', element: <ProfileScreen /> },
  { path: '/marketplace/profile/:address', element: <UserProfileScreen /> },
  { path: '/marketplace/creator/:address', element: <CreatorScreen /> },
  { path: '/tokens', element: <TokensScreen /> },
  { path: '/tokens/:assetId', element: <TokenDetailScreen /> },
  { path: '/marketplace/:id', element: <CollectionScreen /> },
  { path: '/marketplace/:id/manage', element: <ManageScreen /> },
])

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ToastProvider>
      <CartProvider>
        <RouterProvider router={router} />
      </CartProvider>
    </ToastProvider>
  </StrictMode>,
)
