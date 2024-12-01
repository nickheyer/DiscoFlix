from django.shortcuts import redirect
from django.urls import reverse
from DiscoFlixClient.models import Configuration


class LoginRequiredMiddleware:
    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        if request.path.startswith(reverse("login")) or request.path.startswith(reverse("disable_login_requirement")):
            return self.get_response(request)

        config = Configuration.objects.first()
        if config and config.is_login_required and not request.user.is_authenticated:
            return redirect(reverse("login"))

        return self.get_response(request)
