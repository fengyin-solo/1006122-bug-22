import { createApp } from 'vue'
import { createPinia } from 'pinia'

import App from './App.vue'
import router from './router'
import { migrateCrewLedger } from './data/crew-service'
import './styles/global.css'

// 先做存量班组台账迁移（清洗脏口径、按进场日期重排、补挂销账待办），再挂页面。
migrateCrewLedger()

const app = createApp(App)
app.use(createPinia())
app.use(router)
app.mount('#app')
