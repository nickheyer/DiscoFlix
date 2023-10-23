
from django.contrib import admin
from django.urls import include, path
from drf_spectacular.views import SpectacularAPIView, SpectacularSwaggerView


urlpatterns = [
    path("", include("DiscoFlixClient.urls")),
    path('db/', admin.site.urls),
    path('docs/schema/', SpectacularAPIView.as_view(), name='schema'),
    path('docs/schema/swagger-ui/', SpectacularSwaggerView.as_view(url_name='schema'), name='swagger-ui'),
]
