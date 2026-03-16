// Runs in MAIN world (page context) - hooks fetch to capture Authorization header
(function() {
  const nativeFetch = window.fetch;

  window.fetch = function(...args) {
    const request = args[0];
    const init = args[1] || {};

    // Capture Authorization header from any request to api.avalab.ai
    try {
      let url = '';
      if (typeof request === 'string') {
        url = request;
      } else if (request instanceof Request) {
        url = request.url;
      }

      if (url.includes('api.avalab.ai')) {
        let auth = null;

        // Check init.headers
        if (init.headers) {
          if (init.headers instanceof Headers) {
            auth = init.headers.get('Authorization');
          } else if (Array.isArray(init.headers)) {
            const found = init.headers.find(h => h[0].toLowerCase() === 'authorization');
            if (found) auth = found[1];
          } else if (typeof init.headers === 'object') {
            auth = init.headers['Authorization'] || init.headers['authorization'];
          }
        }

        // Check Request object headers
        if (!auth && request instanceof Request) {
          auth = request.headers.get('Authorization');
        }

        if (auth) {
          window.postMessage({ type: 'AVALAB_EXT_AUTH', token: auth }, '*');
        }
      }
    } catch (e) {
      // ignore
    }

    return nativeFetch.apply(this, args);
  };

  // Also hook XMLHttpRequest
  const origSend = XMLHttpRequest.prototype.send;
  const origSetHeader = XMLHttpRequest.prototype.setRequestHeader;
  const origOpen = XMLHttpRequest.prototype.open;

  XMLHttpRequest.prototype.open = function(method, url, ...rest) {
    this._avalabUrl = url;
    return origOpen.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.setRequestHeader = function(name, value) {
    if (this._avalabUrl && this._avalabUrl.includes('api.avalab.ai') &&
        name.toLowerCase() === 'authorization') {
      window.postMessage({ type: 'AVALAB_EXT_AUTH', token: value }, '*');
    }
    return origSetHeader.call(this, name, value);
  };
})();
