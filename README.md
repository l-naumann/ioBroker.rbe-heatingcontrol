# ioBroker.cmi

![Logo](admin/cmi.png)

Adapter for CMI heating controller portal automation

## Description

This adapter connects to the cmi.ta.co.at portal to automatically read heating controller data and control setpoints.

## Configuration

- **CMI Name**: The name of your CMI device (e.g., cmi088364)
- **Email**: Your login email for the CMI portal  
- **Password**: Your login password for the CMI portal
- **Poll Interval**: How often to poll for new data (default: 30 seconds)

## Features

- Automatic login to CMI portal
- Regular polling of heating system data
- Extraction of values, temperatures, and status information
- Control of setpoints (temperature settings)
- Automatic session management and re-login

## States

The adapter creates several state categories:

- `info.connection` - Connection status to the CMI portal
- `values.*` - Read-only values from the heating system
- `controls.*` - Controllable values (like temperature setpoints)  
- `status.*` - Status indicators and system states

## Changelog

### 1.0.0 (2025-09-27)
- Initial release
- Basic CMI portal integration
- Value reading and control functionality

## License
MIT License

Copyright (c) 2025 Lukas Naumann

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.