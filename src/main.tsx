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

const router = createBrowserRouter([
  { path: '/', element: <WalletApp /> },
  { path: '/create', element: <CreateScreen /> },
  { path: '/marketplace', element: <MarketplaceScreen /> },
  { path: '/marketplace/offers', element: <OffersScreen /> },
  { path: '/marketplace/rankings', element: <RankingsScreen /> },
  { path: '/marketplace/activity', element: <ActivityScreen /> },
  { path: '/marketplace/profile', element: <ProfileScreen /> },
  { path: '/marketplace/:id', element: <CollectionScreen /> },
  { path: '/marketplace/:id/manage', element: <ManageScreen /> },
])

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
)
