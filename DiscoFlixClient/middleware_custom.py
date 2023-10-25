from django.utils.deprecation import MiddlewareMixin

class DisableCSRF(MiddlewareMixin):
    def process_request(self, request):
        """
        Disable CSRF validation. It's dumb and unneccesary for single user application.
        """
        setattr(request, '_dont_enforce_csrf_checks', True)
            
        return None