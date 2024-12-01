from rest_framework import permissions
from DiscoFlixClient.models import Configuration

class AllowGETUnauthenticated(permissions.BasePermission):
    def has_permission(self, request, view):
        config = Configuration.objects.first()
        if config and config.is_login_required:
            return request.user and request.user.is_authenticated
        return request.method in ['GET']
