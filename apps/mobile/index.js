// Capture the URL the web app was opened on before the router can change it.
import './src/lib/returnPath';
// Registers the background GPS task; iOS may launch the app in the background just to run it.
import './src/lib/gps';
import 'expo-router/entry';
