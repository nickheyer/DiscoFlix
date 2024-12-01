from rest_framework import viewsets, permissions, status, mixins
from rest_framework.response import Response
from django.http import JsonResponse
from django.conf import settings
from django.shortcuts import render, redirect
from django.contrib.auth import login, authenticate
from django.contrib.auth.forms import AuthenticationForm

from DiscoFlixClient.utils import (
    update_state_sync,
    update_config_sync
)

from DiscoFlixClient.permissions import AllowGETUnauthenticated

# ---------------- INDEX, ETC. ----------------

def index(request):
    update_state_sync({ 'host_url': request.get_host() })
    return render(request, "DiscoFlixClient/index.html")

def login_view(request):
    if request.method == "POST":
        form = AuthenticationForm(data=request.POST)
        if form.is_valid():
            user = form.get_user()
            login(request, user)
            return redirect('index') # REDIR TO SPA INDEX
    else:
        form = AuthenticationForm()
    return render(request, 'DiscoFlixClient/login.html', {'form': form}) # REDIR TO LOGIN PANEL

def disable_login_requirement(request):
    provided_key = request.POST.get('key')
    if provided_key != settings.SECRET_KEY:
        return JsonResponse({'error': 'Invalid key'}, status=403)
    else:
        update_config_sync({ "is_login_required": False })
    return redirect('index') # REDIR TO SPA INDEX

# ---------------- REST API --------------------

from DiscoFlixClient import models, serializers


# Configuration / State limited to update (PUT)
class ConfigurationViewSet(mixins.RetrieveModelMixin,
                           mixins.UpdateModelMixin,
                           mixins.ListModelMixin,
                           viewsets.GenericViewSet):
    permission_classes = [permissions.IsAuthenticated, permissions.IsAdminUser]
    serializer_class = serializers.ConfigurationSerializer
     
    def get_queryset(self):
        return models.Configuration.objects.all()

    def update(self, request, *args, **kwargs):
        instance = self.get_object()
        data = request.data
        instance.is_login_required = data.get("is_login_required", instance.is_login_required)
        instance.save()
        return Response({"status": "updated"}, status=status.HTTP_200_OK)


class StateViewSet(mixins.RetrieveModelMixin,
                  mixins.UpdateModelMixin,
                  mixins.ListModelMixin,
                  viewsets.GenericViewSet):
    permission_classes = [permissions.IsAuthenticatedOrReadOnly, ]
    serializer_class = serializers.StateSerializer

    def get_queryset(self):
        return models.State.objects.filter(id=models.State.objects.first().id)


class ErrLogViewSet(viewsets.ModelViewSet):
    permission_classes = [permissions.IsAuthenticatedOrReadOnly, ]
    queryset = models.ErrLog.objects.all()
    serializer_class = serializers.ErrLogSerializer

class EventLogViewSet(viewsets.ModelViewSet):
    permission_classes = [permissions.IsAuthenticatedOrReadOnly, ]
    queryset = models.EventLog.objects.all()
    serializer_class = serializers.EventLogSerializer

class DiscordServerViewSet(viewsets.ModelViewSet):
    permission_classes = [permissions.IsAuthenticatedOrReadOnly, ]
    queryset = models.DiscordServer.objects.all()
    serializer_class = serializers.DiscordServerSerializer

class MediaViewSet(viewsets.ModelViewSet):
    permission_classes = [permissions.IsAuthenticatedOrReadOnly, ]
    queryset = models.Media.objects.all()
    serializer_class = serializers.MediaSerializer

class MediaRequestViewSet(viewsets.ModelViewSet):
    permission_classes = [permissions.IsAuthenticatedOrReadOnly, ]
    queryset = models.MediaRequest.objects.all()
    serializer_class = serializers.MediaRequestSerializer

class UserViewSet(viewsets.ModelViewSet):
    permission_classes = [permissions.IsAuthenticated, permissions.IsAdminUser]
    queryset = models.User.objects.all()
    serializer_class = serializers.UserSerializer