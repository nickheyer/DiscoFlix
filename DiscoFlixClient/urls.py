from django.urls import path, include
from rest_framework.routers import DefaultRouter
from django.contrib.auth.views import LogoutView

from DiscoFlixClient import views

router = DefaultRouter()
router.register(r'configuration', views.ConfigurationViewSet, basename='configuration')
router.register(r'state', views.StateViewSet, basename='state')
router.register(r'errlogs', views.ErrLogViewSet)
router.register(r'eventlogs', views.EventLogViewSet)
router.register(r'discord-servers', views.DiscordServerViewSet)
router.register(r'media', views.MediaViewSet)
router.register(r'media-requests', views.MediaRequestViewSet)
router.register(r'users', views.UserViewSet)

urlpatterns = [
    path("", views.index, name="index"),
    path("api/", include(router.urls)),
    path('login/', views.login_view, name='login'),
    path('logout/', LogoutView.as_view(), name='logout'),
    path('disable-login/', views.disable_login_requirement, name='disable_login_requirement'),
]
