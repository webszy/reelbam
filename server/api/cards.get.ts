import { listFeaturedTemplates, toWheelCard } from '../../shared/templates'

export default defineEventHandler(() => ({
  cards: listFeaturedTemplates().map(toWheelCard),
}))
